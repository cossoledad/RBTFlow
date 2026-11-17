import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RBToolsAdapter, RepositoryContext } from '../adapters/rbtools';
import { InboxSession, InboxStore } from '../application/inboxSession';
import { DiscussionSession } from '../application/discussionSession';
import { StateStorage } from '../application/repositoryStore';
import { RemoteComparison } from '../domain/comparison';
import { commentLocation, DiscussionComment, DiscussionReview, messageText } from '../domain/discussion';
import { emptyInbox, inboxEntry, inboxKey, isUnread, readInbox, sortInbox, syncInbox } from '../domain/inbox';
import { ReviewResource } from '../domain/model';
import { PublicActivity, WatchResult } from '../domain/activity';

export class MemoryState implements StateStorage {
    private data: Record<string, unknown>;
    constructor(serialized = '{}') { this.data = JSON.parse(serialized) as Record<string, unknown>; }
    get<T>(key: string): T | undefined { return structuredClone(this.data[key]) as T | undefined; }
    async update(key: string, value: unknown): Promise<void> { this.data[key] = structuredClone(value); }
    serialize(): string { return JSON.stringify(this.data); }
}
const identity = { server: 'https://reviews.example.test/', username: 'alice' };
function request(id = 1, changes: Partial<ReviewResource> = {}): ReviewResource {
    const server = identity.server;
    return { id, summary: 'Change', description: 'Full description', testing_done: '', branch: 'main', bugs_closed: [],
        public: true, status: 'pending', created_with_history: false, last_updated: '2026-01-01T00:00:00Z', extra_data: {},
        target_people: [{ title: 'alice', href: server + 'api/users/alice/' }], target_groups: [],
        links: { submitter: { title: 'bob', href: server + 'api/users/bob/' }, latest_diff: { href: server + `api/review-requests/${id}/diffs/1/` } }, ...changes };
}

test('inbox silently bootstraps; real content updates re-alert exactly once, activity timestamps do not', () => {
    const initial = inboxEntry(request(), false), boot = syncInbox(emptyInbox(identity), [initial], 'boot');
    assert.deepEqual(boot.arrivals, []); assert(isUnread(boot.state, initial));
    const read = readInbox(boot.state, [initial], true); assert(!isUnread(read, initial));
    const activity = inboxEntry(request(1, { last_updated: '2026-01-02T00:00:00Z' }), false);
    const unchanged = syncInbox(read, [activity], 'activity');
    assert.deepEqual(unchanged.arrivals, []); assert(!isUnread(unchanged.state, activity));
    for (const update of [request(1, { description: 'Addressed feedback' }), request(1, { links: { ...request().links, latest_diff: { href: identity.server + 'api/review-requests/1/diffs/2/' } } })]) {
        const next = inboxEntry(update, false), result = syncInbox(unchanged.state, [next], 'updated');
        assert.deepEqual(result.arrivals, [next]); assert(isUnread(result.state, next));
        assert.deepEqual(syncInbox(result.state, [next], 'again').arrivals, []);
        assert(isUnread(readInbox(result.state, [initial], true), next), 'A delayed open of v1 cannot read an unseen update');
    }
    const other = inboxEntry(request(2), true), sorted = syncInbox(read, [initial, other], 'new');
    assert.equal(sortInbox(sorted.state)[0]?.id, 2);
    assert(isUnread(readInbox(read, [initial], false), initial));
});

test('read markers persist by account/server, and a queued poll preserves a concurrent read', async () => {
    const storage = new MemoryState(), store = new InboxStore(storage), entry = inboxEntry(request(), false);
    await store.update(identity, state => syncInbox(state, [entry], 'boot').state);
    await Promise.all([store.mark(identity, [entry], true), store.update(identity, state => syncInbox(state, [entry], 'poll').state)]);
    const reopened = new InboxStore(new MemoryState(storage.serialize()));
    assert(!isUnread(reopened.get(identity), entry));
    for (const other of [{ ...identity, username: 'charlie' }, { ...identity, server: 'https://another.example.test/' }]) {
        assert.notEqual(inboxKey(identity), inboxKey(other)); assert.equal(reopened.get(other).initialized, false);
        assert(isUnread(reopened.get(other), entry));
    }
    const next = inboxEntry(request(1, { description: 'New version' }), false);
    await store.update(identity, state => syncInbox(state, [next], 'update').state);
    await store.mark(identity, [entry], true);
    assert(isUnread(store.get(identity), next), 'Mark all of a previously rendered list cannot read a later version');
});

class InboxBackend extends RBToolsAdapter {
    account = identity.username; calls = 0; fail = false; gate?: Promise<void>; changeAccount = false;
    direct = [request(), request(2, { target_people: [] }), request(3, { public: false }), request(4, { status: 'submitted' }),
        request(5, { links: { ...request().links, submitter: { title: identity.username, href: identity.server + 'api/users/alice/' } } })];
    group = [request(6, { target_people: [], target_groups: [{ href: identity.server + 'api/groups/team/', title: 'team' }] })];
    own: ReviewResource[] = [];
    lastActivity: PublicActivity = { id: 1, type: 'diff', timestamp: '2026-01-01T00:00:00Z', actor: 'bob' };
    activityErrors: number[] = [];
    constructor() { super('/unused', { executable: 'unused', storage: '/unused', server: identity.server }); }
    override async context(): Promise<RepositoryContext> { return { server: identity.server, defaults: {} }; }
    override async username(): Promise<string> { return this.account; }
    override async list<T>(_resource: string, _key: string, query: Record<string, string> = {}): Promise<T[]> {
        this.calls++; await this.gate;
        if (this.fail) { throw new Error('Offline'); }
        if (this.changeAccount) { this.account = 'changed'; }
        return structuredClone(query['from-user'] ? this.own : query['to-users-directly'] ? this.direct : this.group) as T[];
    }
    override async watch(ids: number[]): Promise<WatchResult> {
        return { username: this.account, updates: ids.filter(id => !this.activityErrors.includes(id)).map(id => ({ ...this.lastActivity, id })),
            errors: this.activityErrors.map(id => ({ id, code: 100, message: 'Unavailable' })) };
    }
}

test('inbox only includes real direct/group assignments, and failure, cancellation or account changes do not advance storage', async () => {
    const storage = new MemoryState(), store = new InboxStore(storage), backend = new InboxBackend(), session = new InboxSession(() => backend, store);
    const first = await session.refresh(identity.server);
    assert.deepEqual(first.state.entries.map(entry => entry.id), [1, 6]); assert(first.state.entries[1]?.viaGroup);
    const before = storage.serialize(); backend.fail = true;
    await assert.rejects(session.refresh(identity.server), /Offline/); assert.equal(storage.serialize(), before);
    backend.fail = false; backend.changeAccount = true;
    await assert.rejects(session.refresh(identity.server), /Account changed/); assert.equal(storage.serialize(), before);
    backend.changeAccount = false; backend.account = identity.username;
    let release!: () => void; backend.gate = new Promise<void>(resolve => { release = resolve; });
    const expectedCalls = backend.calls + 3, pending = session.refresh(identity.server); while (backend.calls < expectedCalls) { await new Promise(resolve => setImmediate(resolve)); }
    session.cancel(); release(); await assert.rejects(pending, /cancelled/); assert.equal(storage.serialize(), before);
});

test('comment and reply activity re-alerts once, own actions preserve read state, and issue-only changes remain visible', async () => {
    const store = new InboxStore(new MemoryState()), backend = new InboxBackend(), session = new InboxSession(() => backend, store);
    const boot = await session.refresh(identity.server); await store.mark(identity, boot.state.entries, true);
    for (const type of ['review', 'reply']) {
        backend.lastActivity = { ...backend.lastActivity, type, timestamp: type };
        const result = await session.refresh(identity.server);
        assert.equal(result.arrivals.length, 2); assert.equal(result.notices.length, 2);
        assert(result.state.entries.every(entry => isUnread(result.state, entry)));
        assert.equal((await session.refresh(identity.server)).notices.length, 0);
        await store.mark(identity, result.state.entries, true);
    }
    backend.lastActivity = { ...backend.lastActivity, actor: identity.username, timestamp: 'own-review' };
    const own = await session.refresh(identity.server); assert.equal(own.notices.length, 0);
    assert(own.state.entries.every(entry => !isUnread(own.state, entry)));
    Object.assign(backend.direct[0]!, { issue_resolved_count: 1 });
    const issues = await session.refresh(identity.server); assert.equal(issues.notices.length, 1);
    assert.equal(issues.notices[0]?.id, 1, 'An issue update with an unchanged last-activity stamp is still significant');
    backend.lastActivity = { ...backend.lastActivity, actor: 'bob', timestamp: 'next' }; backend.activityErrors = [1];
    const oldToken = issues.state.entries.find(entry => entry.id === 1)!.activityToken;
    assert.equal((await session.refresh(identity.server)).state.entries.find(entry => entry.id === 1)!.activityToken, oldToken);
    backend.activityErrors = [];
    assert((await session.refresh(identity.server)).notices.some(entry => entry.id === 1), 'Recovery must announce the previously failed activity');
});

test('feedback on authored requests notifies after the silent bootstrap, without adding self-authored inbox assignments', async () => {
    const store = new InboxStore(new MemoryState()), backend = new InboxBackend(), session = new InboxSession(() => backend, store);
    backend.direct = []; backend.group = [];
    backend.own = [request(10, { links: { ...request(10).links, submitter: { title: identity.username, href: identity.server + 'api/users/alice/' } } })];
    assert.equal((await session.refresh(identity.server)).notices.length, 0);
    backend.lastActivity = { ...backend.lastActivity, type: 'review', timestamp: 'review' };
    const result = await session.refresh(identity.server); assert.equal(result.notices[0]?.id, 10); assert.equal(result.state.entries.length, 0);
    assert.equal((await session.refresh(identity.server)).notices.length, 0);
    backend.lastActivity = { ...backend.lastActivity, actor: identity.username, timestamp: 'own-reply' };
    assert.equal((await session.refresh(identity.server)).notices.length, 0);
});

test('comment locations retain formal diff identity and reject interdiffs, foreign requests and absent ranges', () => {
    const comment: DiscussionComment = { id: 10, text: 'Full\ntext', first_line: 4, num_lines: 2, links: { filediff: { href: identity.server + 'api/review-requests/1/diffs/2/files/123/' } } };
    assert.deepEqual(commentLocation(comment, 1), { requestId: 1, revision: 2, fileId: 123, firstLine: 4, numLines: 2 });
    assert.equal(commentLocation(comment, 2), undefined);
    assert.equal(commentLocation({ ...comment, interfilediff: { id: 124 } }, 1), undefined);
    assert.equal(commentLocation({ ...comment, base_filediff_id: 122 }, 1), undefined);
    assert.equal(commentLocation({ ...comment, first_line: 0 }, 1), undefined);
    const rendered = messageText({ key: '10', kind: 'diff', author: 'bob', timestamp: 'now', text: comment.text, issue: 'resolved', location: commentLocation(comment, 1) }, 1);
    assert(rendered.includes('Full\ntext')); assert(rendered.includes('v2')); assert(rendered.includes('resolved'));
});

test('discussion failures are retryable and missing historical file context never hides published text', async () => {
    let fail = true;
    const review: DiscussionReview = { id: 9, public: true, timestamp: 'now', body_top: 'Header', body_bottom: 'Footer', links: { diff_comments: { href: 'unused' }, user: { title: 'bob', href: 'unused' } } };
    class Backend extends RBToolsAdapter {
        override async username(): Promise<string> { return identity.username; }
        override async list<T>(_path: string, key: string): Promise<T[]> {
            if (key === 'reviews') { return [review, { ...review, id: 10, public: false }] as T[]; }
            if (fail) { throw new Error('Comment service unavailable'); }
            return [{ id: 8, text: 'Historic comment', first_line: 3, num_lines: 1, links: { filediff: { href: identity.server + 'api/review-requests/1/diffs/1/files/99/' } } }] as T[];
        }
        override async api<T>(): Promise<T> { throw new Error('File removed'); }
    }
    const adapter = new Backend('/unused', { executable: 'unused', storage: '/unused', server: identity.server });
    const session = new DiscussionSession(() => adapter);
    const comparison = { id: 'comparison', requestId: 1, server: identity.server, username: identity.username, review: request(), files: [] } as unknown as RemoteComparison;
    const index = await session.index(comparison); assert.equal(index.reviews.length, 1);
    await assert.rejects(session.bundle(index, review), /Comment service/); fail = false;
    const bundle = await session.bundle(index, review);
    assert.equal(bundle.messages[1]?.text, 'Historic comment'); assert(bundle.messages[1]?.contextUnavailable);
    const transcript = await session.transcript(comparison);
    for (const text of ['Header', 'Footer', 'Historic comment']) { assert(transcript.includes(text)); }
    session.clear(); await assert.rejects(session.bundle(index, review), /Discussion changed/);
});
