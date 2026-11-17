import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RBToolsAdapter } from '../adapters/rbtools';
import { RequestSession, RequestWrite } from '../application/requestSession';
import { RepositoryStore } from '../application/repositoryStore';
import { sourceRange } from '../domain/comparison';
import { RemoteComparison } from '../domain/comparison';
import { digest, ReviewResource, ReviewSnapshot } from '../domain/model';
import { assertBoundCommit, bindingKey, CommitBinding, fileSetHash, fullCommitId, readBinding, ServerDiff } from '../domain/submission';

const server = 'http://reviews.example.test/', head = 'a'.repeat(40);
const binding: CommitBinding = { version: 1, planId: 'plan', head, repositoryId: 1, targetBranch: 'origin/main', diffId: 4, revision: 1,
    patchHash: digest('patch'), filesHash: fileSetHash(['file.txt']) };
function resource(): ReviewResource {
    return { id: 2, public: false, status: 'pending', created_with_history: false, last_updated: 'now', summary: 'Summary', description: 'Description',
        testing_done: '', branch: 'origin/main', bugs_closed: [], target_people: [{ title: 'bob', href: server + 'api/users/bob/' }], target_groups: [],
        extra_data: {}, commit_id: head, links: { submitter: { title: 'alice', href: server + 'api/users/alice/' }, repository: { href: server + 'api/repositories/1/' } } };
}
function fixture() {
    const review = resource(), snapshot: ReviewSnapshot = { review, draft: { ...review, changedescription: '', extra_data: { rbtflow_binding_version: '1' } }, fingerprint: 'snapshot' };
    const diff: ServerDiff = { id: 4, revision: 1, commit_count: 0, extra_data: { [bindingKey]: JSON.stringify(binding) } };
    let writes = 0, pending: RequestWrite | undefined;
    class Backend extends RBToolsAdapter {
        constructor() { super('/unrelated-checkout', { executable: 'unused', storage: '/unused', server }); }
        override async username(): Promise<string> { return 'alice'; }
        override async snapshot(): Promise<ReviewSnapshot> { return structuredClone(snapshot); }
        override async api<T>(): Promise<T> { return { diff } as T; }
        override async list<T>(_resource: string, key: string): Promise<T[]> { return (key === 'diffs' ? [diff] : [{ source_file: 'file.txt', dest_file: 'file.txt' }]) as T[]; }
        override async patchHash(): Promise<string> { return binding.patchHash; }
        override async validatePeople(): Promise<void> {}
        override async publish(): Promise<void> { writes++; snapshot.review = { ...snapshot.review, ...snapshot.draft!, public: true }; snapshot.draft = null; }
    }
    const comparison = { id: 'comparison', kind: 'remote', server, requestId: 2, username: 'alice', review, selected: { scope: 'draft', revision: 1, id: 4 },
        versions: [{ scope: 'draft', revision: 1, id: 4 }], requestSnapshot: structuredClone(snapshot) } as RemoteComparison;
    const backend = new Backend(), session = new RequestSession(() => backend, { load: () => pending, save: async value => { pending = value; } });
    return { snapshot, diff, comparison, session, writes: () => writes, pending: () => pending };
}

test('full commit IDs and versioned bindings reject abbreviated, null, malformed or divergent identities', () => {
    assert(fullCommitId(head)); assert(fullCommitId('b'.repeat(64)));
    for (const invalid of [null, undefined, '', head.slice(0, 12), 'a'.repeat(41)]) { assert(!fullCommitId(invalid)); }
    assert.equal(readBinding(undefined), undefined); assert.deepEqual(readBinding(JSON.stringify(binding)), binding);
    for (const invalid of ['not-json', {}, { ...binding, head: null }, { ...binding, head: '1234' }, { ...binding, revision: -1 }]) {
        assert.throws(() => readBinding(invalid));
    }
    assert.throws(() => assertBoundCommit(binding, { commit_id: null, branch: 'origin/main' }, { id: 4, revision: 1, extra_data: {} }), /Commit ID/);
});

test('server-only publication verifies the confirmed SHA, branch, diff and file set before any write', async () => {
    for (const change of ['sha', 'branch', 'diff', 'files'] as const) {
        const f = fixture();
        if (change === 'sha') { f.snapshot.draft!.commit_id = 'b'.repeat(40); }
        if (change === 'branch') { f.snapshot.draft!.branch = 'wrong-target'; }
        if (change === 'diff') { f.diff.id = 99; }
        if (change === 'files') { f.diff.extra_data[bindingKey] = JSON.stringify({ ...binding, filesHash: digest('other file set') }); }
        f.comparison.requestSnapshot = structuredClone(f.snapshot);
        await assert.rejects(f.session.publish(f.comparison)); assert.equal(f.writes(), 0); assert.equal(f.pending(), undefined);
    }
    const valid = fixture(); assert.equal((await valid.session.publish(valid.comparison)).published, true); assert.equal(valid.writes(), 1);
    assert.equal(valid.snapshot.review.commit_id, head); assert.equal(valid.pending(), undefined);
    const replaced = fixture(); replaced.comparison.patchHash = digest('other bytes when opened');
    await assert.rejects(replaced.session.publish(replaced.comparison), /diff changed since it was opened/); assert.equal(replaced.writes(), 0);
    for (const version of [1, '1']) {
        const unbound = fixture(); unbound.diff.extra_data = {}; unbound.snapshot.draft!.extra_data.rbtflow_binding_version = version;
        unbound.comparison.requestSnapshot = structuredClone(unbound.snapshot);
        await assert.rejects(unbound.session.publish(unbound.comparison), /no confirmed HEAD binding/); assert.equal(unbound.writes(), 0);
    }
});

test('legacy preferences migrate without altering pending journals or the last request identity', async () => {
    const data: Record<string, unknown> = {}, store = new RepositoryStore('/repo', { get: <T>(key: string) => data[key] as T | undefined, update: async (key, value) => { data[key] = structuredClone(value); } });
    const oldPending = { kind: 'post', plan: { input: { mode: 'history', reviewId: 70 } }, id: 70 };
    await store.set('ownForm', { mode: 'history', reviewId: 70, people: ['bob'], targetRef: 'origin/main' });
    await store.set('defaults', { mode: 'history', people: ['bob'] }); await store.set('submissionPending', oldPending);
    await store.initialize(); assert.equal(store.form().mode, 'history'); assert.equal(store.newForm().mode, 'history');
    assert.equal(store.form().reviewId, 70); assert.deepEqual(store.form().people, ['bob']); assert.deepEqual(store.get('submissionPending'), oldPending);
    const previousVersion = new RepositoryStore('/v05', { get: <T>(key: string) => data[key] as T | undefined, update: async (key, value) => { data[key] = structuredClone(value); } });
    await previousVersion.set('finalDiffDefaults', true); await previousVersion.set('ownForm', { mode: 'squash', people: ['bob'] });
    await previousVersion.set('defaults', { mode: 'squash' }); await previousVersion.set('submissionPending', oldPending);
    await previousVersion.initialize(); assert.equal(previousVersion.form().mode, 'bound'); assert.equal(previousVersion.newForm().mode, 'bound');
    assert.deepEqual(previousVersion.get('submissionPending'), oldPending);
    await previousVersion.saveOwn({ ...previousVersion.form(), mode: 'squash' }); await previousVersion.initialize();
    assert.equal(previousVersion.form().mode, 'squash', 'An explicit new choice must survive later starts');
});

test('comment navigation and native threads share exact original/changed ranges, including deleted and missing rows', () => {
    const map = { rows: [[1, 1, 1], [2, 2, null], [3, 3, null], [4, 4, 2], [5, null, 3]] as [number, number | null, number | null][] };
    assert.deepEqual(sourceRange(map, 2, 2), { side: 'base', start: 2, end: 3 });
    assert.deepEqual(sourceRange(map, 4, 1), { side: 'head', start: 2, end: 2 });
    assert.deepEqual(sourceRange(map, 4, 1, 'base'), { side: 'base', start: 4, end: 4 });
    assert.equal(sourceRange(map, 6, 1), undefined); assert.equal(sourceRange(map, 3, 4), undefined); assert.equal(sourceRange(map, -1, 1), undefined);
});
