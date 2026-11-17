import { RBToolsAdapter } from '../adapters/rbtools';
import { ReviewResource, serverUrl } from '../domain/model';
import { emptyInbox, InboxEntry, inboxEntry, inboxFingerprint, InboxIdentity, inboxKey, InboxState, isUnread, readInbox, syncInbox } from '../domain/inbox';
import { activityToken, eventStamp } from '../domain/activity';
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

export interface InboxResult { state: InboxState; arrivals: InboxEntry[]; notices: InboxEntry[]; }
export class InboxSession {
    private generation = 0;
    identity?: InboxIdentity;
    constructor(private readonly backend: (server: string) => RBToolsAdapter, readonly store: InboxStore) {}
    cancel(): void { this.generation++; }
    async refresh(server: string, signal?: AbortSignal): Promise<InboxResult> {
        const version = ++this.generation, context = await this.backend(server).context(signal), adapter = this.backend(context.server);
        const username = await adapter.username(signal), identity = { server: serverUrl(context.server), username };
        this.identity = identity;
        const [direct, group, own] = await Promise.all([
            adapter.list<ReviewResource>('/review-requests/', 'review_requests', { 'to-users-directly': username, status: 'pending' }, signal),
            adapter.list<ReviewResource>('/review-requests/', 'review_requests', { 'to-users-groups': username, status: 'pending' }, signal),
            adapter.list<ReviewResource>('/review-requests/', 'review_requests', { 'from-user': username, status: 'pending' }, signal),
        ]);
        // The direct API also returns starred requests; only explicit assignments belong here.
        const assigned = direct.filter(review => review.target_people.some(person => person.title === username));
        const groups = new Set(group.map(review => review.id)), unique = new Map([...assigned, ...group].map(review => [review.id, review]));
        const assignedReviews = [...unique.values()].filter(review => review.public && review.status === 'pending' && review.links.submitter?.title !== username);
        const ownReviews = own.filter(review => review.public && review.status === 'pending' && review.links.submitter?.title === username);
        const reviews = [...new Map([...assignedReviews, ...ownReviews].map(review => [review.id, review])).values()];
        const watch = await adapter.watch(reviews.map(review => review.id), undefined, signal);
        if (watch.username !== username) { throw new Error('Account changed during inbox refresh.'); }
        for (const error of watch.errors) { adapter.options.log?.(`Activity refresh failed for #${error.id}: ${error.message}`); }
        const updates = new Map(watch.updates.map(update => [update.id, update]));
        if (username !== await adapter.username(signal)) { throw new Error('Account changed during inbox refresh.'); }
        if (signal?.aborted || version !== this.generation) { throw new Error('Inbox refresh cancelled.'); }
        let arrivals: InboxEntry[] = [], notices: InboxEntry[] = [];
        const state = await this.store.update(identity, previous => {
            let working = structuredClone(previous);
            const entries = assignedReviews.map(review => {
                const old = previous.entries.find(entry => entry.id === review.id), update = updates.get(review.id);
                const entry = inboxEntry(review, groups.has(review.id), update, old?.activityToken);
                if (!update) { entry.activity = old?.activity; }
                const wasRead = old && !isUnread(previous, old);
                const sameContent = old && ((old.contentFingerprint ?? old.fingerprint) === entry.contentFingerprint
                    || (!old.contentFingerprint && old.fingerprint === inboxFingerprint({ ...review, commit_id: undefined })));
                const ownEvent = !!old && update?.actor === username && eventStamp(old.activity) !== eventStamp(update);
                // Preserve read state during activity-cache migration and our own review actions.
                if (wasRead && ((sameContent && !old.activityToken) || ownEvent)) { working = readInbox(working, [entry], true); }
                return entry;
            });
            const next = syncInbox(working, entries, new Date().toISOString());
            arrivals = next.arrivals.filter(entry => entry.activity?.actor !== username
                || eventStamp(previous.entries.find(old => old.id === entry.id)?.activity) === eventStamp(entry.activity));
            const watched = { ...previous.watched };
            const ownNotices: InboxEntry[] = [];
            for (const review of reviews) {
                const key = String(review.id), update = updates.get(review.id), old = watched[key];
                if (!update) { continue; } // A failed request never advances its activity cursor.
                const token = activityToken(review, update), content = inboxFingerprint(review);
                const ownEvent = update.actor === username && eventStamp(old?.activity) !== eventStamp(update);
                if (review.links.submitter?.title === username && old && (old.token !== token || old.content !== content) && !ownEvent) {
                    ownNotices.push(inboxEntry(review, false, update));
                }
                watched[key] = { token, content, activity: update };
            }
            next.state.watched = watched; notices = [...arrivals, ...ownNotices]; return next.state;
        });
        return { state, arrivals, notices };
    }
}
