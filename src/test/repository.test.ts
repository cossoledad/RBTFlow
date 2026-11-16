import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { initialForm, RepositoryStore, StateStorage } from '../application/repositoryStore';
import { virtualRange } from '../domain/comparison';
import { changeTree, DiffNode } from '../domain/fileTree';

class PersistedState implements StateStorage {
    private data: Record<string, unknown>;
    constructor(serialized = '{}') { this.data = JSON.parse(serialized) as Record<string, unknown>; }
    get<T>(key: string): T | undefined { return structuredClone(this.data[key]) as T | undefined; }
    async update(key: string, value: unknown): Promise<void> { if (value === undefined) { delete this.data[key]; } else { this.data[key] = structuredClone(value); } }
    serialize(): string { return JSON.stringify(this.data); }
}

test('repository defaults survive a new workspace/process and remain isolated from another repository', async () => {
    const state = new PersistedState(), a = new RepositoryStore('/repos/a', state), b = new RepositoryStore('/repos/b', state);
    await a.initialize(); await b.initialize();
    const form = { ...initialForm('https://reviews.example.test/'), people: ['alice'], groups: ['team-a'], bugs: ['ABC-12'],
        targetRef: 'origin/develop', baseRef: 'parent', mode: 'history' as const, branch: 'develop', testing: 'unit test',
        repositoryId: 17, reviewId: 123, summary: 'one change', description: 'one description' };
    await a.saveOwn(form); await a.set('settings', { rbtPath: '/tools/rbt', timeoutSeconds: 70 });
    await b.saveOwn({ ...initialForm(), people: ['bob'] });
    const reopened = new RepositoryStore('/repos/a', new PersistedState(state.serialize()), new PersistedState());
    await reopened.initialize();
    assert.deepEqual(reopened.form(), form);
    assert.deepEqual(reopened.settings(), { rbtPath: '/tools/rbt', timeoutSeconds: 70 });
    assert.deepEqual(b.form().people, ['bob']);
    const next = reopened.newForm();
    assert.deepEqual(next.people, ['alice']); assert.equal(next.reviewId, null); assert.equal(next.summary, ''); assert.equal(next.description, '');
    assert.equal(next.targetRef, 'origin/develop'); assert.equal(next.baseRef, 'parent'); assert.equal(next.mode, 'history'); assert.deepEqual(next.bugs, ['ABC-12']);
    next.people.push('not-saved'); assert.deepEqual(reopened.newForm().people, ['alice']);
});

test('legacy submission drafts/pending writes migrate, while loading a review does not replace defaults', async () => {
    const global = new PersistedState(), oldWorkspace = new PersistedState(), root = '/repos/legacy';
    await oldWorkspace.update(`form:${root}`, { ...initialForm(), people: ['default-reviewer'] });
    await oldWorkspace.update(`pending:${root}`, { kind: 'post', id: 42 });
    const store = new RepositoryStore(root, global, oldWorkspace); await store.initialize();
    assert.deepEqual(store.form().people, ['default-reviewer']);
    assert.deepEqual(store.get('submissionPending'), { kind: 'post', id: 42 });
    assert.equal(oldWorkspace.get(`pending:${root}`), undefined);
    await store.saveOwn({ ...store.form(), reviewId: 99, people: ['review-specific'] }, false);
    assert.deepEqual(store.form().people, ['review-specific']);
    assert.deepEqual(store.newForm().people, ['default-reviewer']);
});

test('comments map actual source/destination lines to Review Board virtual rows, including deletions', () => {
    const map = { rows: [[1, 1, 1], [2, 2, null], [3, 3, null], [4, 4, 2], [5, null, 3]] as [number, number | null, number | null][] };
    assert.deepEqual(virtualRange(map, 'head', 2, 2), { firstLine: 4, numLines: 1 });
    assert.deepEqual(virtualRange(map, 'base', 2, 3), { firstLine: 2, numLines: 2 });
    assert.deepEqual(virtualRange(map, 'head', 1, 2), { firstLine: 1, numLines: 4 });
    assert.throws(() => virtualRange(map, 'head', 4, 4), /精确/);
    assert.throws(() => virtualRange(map, 'head', 0, 1), /无效/);
});

test('tree/list layouts retain every file identity across nested folders, renames and Unicode paths', () => {
    const files = [
        { status: 'R100', oldPath: 'old.ts', path: 'src/core/new.ts' }, { status: 'D', oldPath: 'src/old.ts', path: 'src/old.ts' },
        { status: 'A', oldPath: '测试 space/name.md', path: '测试 space/name.md' }, { status: 'M', oldPath: 'README.md', path: 'README.md' },
    ];
    const tree = changeTree(files), leaves: number[] = [];
    const walk = (nodes: DiffNode[]) => { for (const node of nodes) { if (node.kind === 'folder') { walk(node.children); } else { assert.equal(node.file, files[node.index]); leaves.push(node.index); } } };
    walk(tree); assert.deepEqual(leaves.sort(), [0, 1, 2, 3]);
    const src = tree.find(node => node.kind === 'folder' && node.path === 'src'); assert(src?.kind === 'folder');
    assert.equal(src.children[0]?.kind, 'folder');
    assert(tree.at(-1)?.kind === 'file');
});
