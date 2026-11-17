import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { GitAdapter } from '../adapters/git';
import { RBToolsAdapter } from '../adapters/rbtools';
import { ProcessError, runProcess } from '../adapters/process';
import { ReviewSession } from '../application/reviewSession';
import { ReviewPlan } from '../domain/model';
import { FilePending, fields, git, input, labRoot, project, rbtPath, temporary, uniqueFixtureHead } from './helpers';

const specsPromise = readFile(path.join(project, 'build/fixtures.json'), 'utf8').then(text => JSON.parse(text) as {
    scenarios: Record<string, { base: string; head: string }>;
});
async function sessionFor(head: string, fault = false) {
    const dir = await temporary('integration-'), root = path.join(dir, 'worktree');
    await git(labRoot, 'worktree', 'add', '--detach', root, head);
    await copyFile(path.join(labRoot, '.reviewboardrc'), path.join(root, '.reviewboardrc'));
    await uniqueFixtureHead(root);
    const store = new FilePending(path.join(dir, 'pending.json')); await store.initialize();
    class LostResponse extends RBToolsAdapter {
        override async post(...args: Parameters<RBToolsAdapter['post']>): Promise<number> {
            const id = await super.post(...args);
            await this.replaceFields(args[0], args[1], id, args[2]);
            throw new ProcessError('Injected lost response after server save', Buffer.alloc(0), Buffer.alloc(0), 'exit');
        }
    }
    const factory = (server: string) => new (fault ? LostResponse : RBToolsAdapter)(root, { executable: rbtPath, storage: dir, server });
    return { dir, root, store, session: new ReviewSession(root, new GitAdapter(), factory, store), factory,
        cleanup: async () => { await git(labRoot, 'worktree', 'remove', '--force', root); } };
}
async function verifyServerTree(plan: ReviewPlan, id: number, revision: number, published = false): Promise<void> {
    const prefix = `${plan.server}api/review-requests/${id}/${published ? '' : 'draft/'}diffs/${revision}/`;
    const response = await fetch(prefix, { headers: { Authorization: `Basic ${Buffer.from('admin:rbtflow-local').toString('base64')}`, Accept: 'text/x-patch' } });
    assert.equal(response.status, 200);
    const patch = Buffer.from(await response.arrayBuffer());
    const dir = await temporary('tree-'), patchFile = path.join(dir, 'server.patch');
    await writeFile(patchFile, patch);
    const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
    await runProcess('git', ['read-tree', plan.git.base], { cwd: plan.git.root, env });
    await runProcess('git', ['apply', '--cached', patchFile], { cwd: plan.git.root, env });
    assert.equal((await runProcess('git', ['write-tree'], { cwd: plan.git.root, env })).toString(),
        (await git(plan.git.root, 'rev-parse', plan.git.head + '^{tree}')).toString());
}

test('real adapter posts all five Git shapes; published review is updated in place', { timeout: 120_000 }, async () => {
    const { scenarios } = await specsPromise;
    const refs = await git(labRoot, 'show-ref'), branch = await git(labRoot, 'symbolic-ref', 'HEAD'), status = await git(labRoot, 'status', '--porcelain=v1', '-z');
    for (const [name, spec] of Object.entries(scenarios)) {
        const { session, cleanup } = await sessionFor(spec.head);
        const plan = await session.preview({ ...input, baseRef: name === 'stacked-child' ? spec.base : '' });
        assert.equal(plan.git.base, spec.base);
        assert.equal(plan.input.mode, 'bound'); assert.equal(plan.bindingVersion, 1);
        const receipt = await session.post(plan.id, plan.input, { ...fields, summary: fields.summary + ': ' + name });
        assert.equal(receipt.published, false);
        assert.equal(session.pending, undefined);
        await verifyServerTree(plan, receipt.id, receipt.diffRevision);
        const uploaded = await session.backend(plan.server).snapshot(receipt.id);
        assert.equal(uploaded.draft?.commit_id, plan.git.head); assert.equal(uploaded.review.created_with_history, false);
        assert.equal(uploaded.draft?.branch, plan.input.targetRef);
        if (name === 'merged') {
            const current = session.plan!;
            await session.publish(current.id, current.input, { ...fields, summary: fields.summary + ': ' + name });
            await git(session.root, 'switch', '--detach', scenarios['conflict-resolved']!.head);
            await uniqueFixtureHead(session.root);
            const updated = await session.preview({ ...input, server: plan.server, reviewId: receipt.id });
            const next = await session.post(updated.id, updated.input, fields);
            assert.equal(next.id, receipt.id);
            assert.equal(next.diffRevision, 2);
            const saved = session.plan!;
            await session.publish(saved.id, saved.input, fields);
            await verifyServerTree(updated, next.id, 2, true);
            const clearing = await session.preview({ ...input, reviewId: next.id });
            const empty = { ...fields, description: '', testing: '', people: [], groups: [], bugs: [], branch: input.targetRef };
            const cleared = await session.post(clearing.id, clearing.input, empty);
            assert.equal(cleared.id, next.id);
        }
        await cleanup();
    }
    assert.deepEqual(await git(labRoot, 'show-ref'), refs);
    assert.deepEqual(await git(labRoot, 'symbolic-ref', 'HEAD'), branch);
    assert.deepEqual(await git(labRoot, 'status', '--porcelain=v1', '-z'), status);
});

test('Git drift and concurrent edits are rejected; mode changes cannot convert an existing final diff', { timeout: 60_000 }, async () => {
    const { scenarios } = await specsPromise;
    const { root, session, factory, cleanup } = await sessionFor(scenarios.merged!.head);
    let plan = await session.preview(input);
    await writeFile(path.join(root, 'uncommitted.txt'), 'excluded');
    await assert.rejects(session.post(plan.id, plan.input, fields), /Git.*变化/);
    assert.equal(session.pending, undefined);
    plan = await session.preview(input);
    const receipt = await session.post(plan.id, plan.input, fields);
    await assert.rejects(session.preview({ ...input, reviewId: receipt.id, mode: 'history' }), /Create a new request/);
    await assert.rejects(session.preview({ ...input, reviewId: receipt.id, mode: 'squash' }), /HEAD binding/);
    const loaded = await session.preview({ ...input, reviewId: receipt.id });
    const outsider = factory(loaded.server);
    await outsider.post({ ...loaded, id: loaded.id + '-external' }, { ...fields, summary: 'Changed in another client' });
    await assert.rejects(session.post(loaded.id, loaded.input, fields), /审核单已被修改/);
    assert.equal(session.pending, undefined);
    await cleanup();
});

test('lost response after actual server save survives session restart and reconciles without another post', { timeout: 60_000 }, async () => {
    const { scenarios } = await specsPromise;
    const data = await sessionFor(scenarios.merged!.head, true);
    const plan = await data.session.preview(input);
    await assert.rejects(data.session.post(plan.id, plan.input, fields), /Injected lost response/);
    assert(data.store.load());
    assert.equal(data.store.load()!.id, undefined);
    const store = new FilePending(path.join(data.dir, 'pending.json')); await store.initialize();
    const factory = (server: string) => new RBToolsAdapter(data.root, { executable: rbtPath, storage: data.dir, server });
    const restarted = new ReviewSession(data.root, new GitAdapter(), factory, store);
    await assert.rejects(restarted.post(plan.id, plan.input, fields), /待确认/);
    const receipt = await restarted.reconcile();
    assert(receipt);
    assert.equal(restarted.pending, undefined);
    assert.equal(receipt.diffRevision, 1);
    await verifyServerTree(plan, receipt.id, 1);
    await data.cleanup();
});
