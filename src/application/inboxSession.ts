import { RBToolsAdapter } from '../adapters/rbtools';
import { ReviewResource, serverUrl } from '../domain/model';
import { emptyInbox, InboxEntry, inboxEntry, InboxIdentity, inboxKey, InboxState, readInbox, syncInbox } from '../domain/inbox';
import { StateStorage } from './repositoryStore';

/** Serialize local updates so reading a request during a poll never loses the read marker. */
export class InboxStore {
    private readonly queues = new Map<string, Promise<unknown>>();
    constructor(private readonly storage: StateStorage) {}
    get(identity: InboxIdentity): InboxState { return structuredClone(this.storage.get<InboxState>('inbox:v1:' + inboxKey(identity)) ?? emptyInbox(identity)); }
    async update(identity: InboxIdentity, change: (state: InboxState) => InboxState): Promise<InboxState> {
        const key = inboxKey(identity), prior = this.queues.get(key) ?? Promise.resolve();
        const operation = prior.catch(() => {}).then(async () => {
            const state = change(this.get(identity)); await this.storage.update('inbox:v1:' + key, state); return state;
        });
        this.queues.set(key, operation);
        try { return await operation; } finally { if (this.queues.get(key) === operation) { this.queues.delete(key); } }
    }
    async mark(identity: InboxIdentity, observations: { id: number; fingerprint: string }[], read: boolean): Promise<InboxState> {
        return this.update(identity, state => readInbox(state, observations, read));
    }
}

export interface InboxResult { state: InboxState; arrivals: InboxEntry[]; }
export class InboxSession {
    private generation = 0;
    identity?: InboxIdentity;
    constructor(private readonly backend: (server: string) => RBToolsAdapter, readonly store: InboxStore) {}
    cancel(): void { this.generation++; }
    async refresh(server: string, signal?: AbortSignal): Promise<InboxResult> {
        const version = ++this.generation, context = await this.backend(server).context(signal), adapter = this.backend(context.server);
        const username = await adapter.username(signal), identity = { server: serverUrl(context.server), username };
        this.identity = identity;
        const [direct, group] = await Promise.all([
            adapter.list<ReviewResource>('/review-requests/', 'review_requests', { 'to-users-directly': username, status: 'pending' }, signal),
            adapter.list<ReviewResource>('/review-requests/', 'review_requests', { 'to-users-groups': username, status: 'pending' }, signal),
        ]);
        // The direct API also returns starred requests; only explicit assignments belong here.
        const assigned = direct.filter(review => review.target_people.some(person => person.title === username));
        const groups = new Set(group.map(review => review.id)), unique = new Map([...assigned, ...group].map(review => [review.id, review]));
        const entries = [...unique.values()].filter(review => review.public && review.status === 'pending' && review.links.submitter?.title !== username)
            .map(review => inboxEntry(review, groups.has(review.id)));
        if (username !== await adapter.username(signal)) { throw new Error('Account changed during inbox refresh.'); }
        if (signal?.aborted || version !== this.generation) { throw new Error('Inbox refresh cancelled.'); }
        let arrivals: InboxEntry[] = [];
        const state = await this.store.update(identity, previous => { const next = syncInbox(previous, entries, new Date().toISOString()); arrivals = next.arrivals; return next.state; });
        return { state, arrivals };
    }
}
