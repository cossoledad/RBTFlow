import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ApiError, RBToolsAdapter } from '../adapters/rbtools';
import { ProcessError } from '../adapters/process';
import { GitAdapter } from '../adapters/git';
import { ReviewSession } from '../application/reviewSession';
import { ReviewBrowser } from '../application/reviewBrowser';
import { RequestSession } from '../application/requestSession';
import { FeedbackSession } from '../application/feedbackSession';
import { bindingKey, CommitConflictError, readBinding, ServerDiff } from '../domain/submission';
import { ReviewWrite } from '../domain/comparison';
import { patchDigest } from '../domain/model';
import { FilePending, fields, git, input, labApi, labRoot, project, rbtPath, temporary, uniqueFixtureHead } from './helpers';

async function setup(branch = 'feature/merged') {
    const dir = await temporary('binding-'), root = path.join(dir, 'worktree'), server = 'http://127.0.0.1:8080/';
    await git(labRoot, 'worktree', 'add', '--detach', root, branch);
    await copyFile(path.join(labRoot, '.reviewboardrc'), path.join(root, '.reviewboardrc')); await uniqueFixtureHead(root);
    const factory = (address: string) => new RBToolsAdapter(root, { executable: rbtPath, storage: dir, server: address || server });
    const store = new FilePending(path.join(dir, 'pending.json')); await store.initialize();
    return { dir, root, server, factory, store, cleanup: async () => { await git(labRoot, 'worktree', 'remove', '--force', root); } };
}

test('failed HEAD binding retains one uploaded request, blocks publication and explicitly completes without uploading again', { timeout: 90_000 }, async () => {
    const f = await setup(); let fail = true;
    class RejectedBinding extends RBToolsAdapter {
        override async replaceFields(...args: Parameters<RBToolsAdapter['replaceFields']>): Promise<void> {
            if (fail) { throw new ApiError('Injected unsupported native commit field', 105); } await super.replaceFields(...args);
        }
    }
    const session = new ReviewSession(f.root, new GitAdapter(), address => new RejectedBinding(f.root, { ...f.factory(address).options }), f.store);
    await assert.rejects(session.preview({ ...input, mode: 'history' }), /linear branch/);
    const plan = await session.preview(input);
    assert.equal(plan.input.mode, 'bound'); assert.equal((await git(f.root, 'rev-list', '--parents', '-n', '1', 'HEAD')).toString().trim().split(' ').length, 3);
    const refs = await git(f.root, 'show-ref'), head = await git(f.root, 'rev-parse', 'HEAD'), status = await git(f.root, 'status', '--porcelain=v1', '-z'), index = await git(f.root, 'write-tree');
    await assert.rejects(session.post(plan.id, plan.input, fields), /Injected unsupported/);
    const pending = f.store.load()!; assert(pending.id); assert(pending.bindingCheckpoint); assert.equal(pending.plan.git.head, plan.git.head);
    const adapter = f.factory(f.server), browser = new ReviewBrowser(f.factory), before = await adapter.list<ServerDiff>(`/review-requests/${pending.id}/draft/diffs/`, 'diffs');
    const request = new RequestSession(f.factory, { load: () => undefined, save: async () => {} });
    await assert.rejects(request.publish(await browser.open(f.server, pending.id)), /no confirmed HEAD binding/);
    assert(!(await adapter.snapshot(pending.id)).review.public); fail = false;
    const completed = await session.completeBinding(); assert.equal(completed.id, pending.id); assert.equal(f.store.load(), undefined);
    assert.deepEqual((await adapter.list<ServerDiff>(`/review-requests/${pending.id}/draft/diffs/`, 'diffs')).map(diff => diff.id), before.map(diff => diff.id));
    assert.equal((await adapter.snapshot(pending.id)).draft?.commit_id, plan.git.head);
    assert.deepEqual(await git(f.root, 'show-ref'), refs); assert.deepEqual(await git(f.root, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(await git(f.root, 'status', '--porcelain=v1', '-z'), status); assert.deepEqual(await git(f.root, 'write-tree'), index);
    await git(f.root, 'switch', '--detach', 'origin/main');
    await request.publish(await browser.open(f.server, pending.id)); assert.equal((await adapter.snapshot(pending.id)).review.commit_id, plan.git.head);
    const diff = (await adapter.api<{ diff: ServerDiff }>(`/review-requests/${pending.id}/diffs/1/`)).diff;
    assert.equal(diff.commit_count, 0); assert.equal(readBinding(diff.extra_data[bindingKey])?.head, plan.git.head);
    await f.cleanup();
});

test('lost binding response reconciles after restart; an actual SHA mismatch or external unbound diff cannot be published', { timeout: 90_000 }, async () => {
    const f = await setup();
    class LostBinding extends RBToolsAdapter {
        override async replaceFields(...args: Parameters<RBToolsAdapter['replaceFields']>): Promise<void> {
            await super.replaceFields(...args); throw new ProcessError('Injected lost binding response', Buffer.alloc(0), Buffer.alloc(0), 'exit');
        }
    }
    const session = new ReviewSession(f.root, new GitAdapter(), address => new LostBinding(f.root, { ...f.factory(address).options }), f.store), plan = await session.preview(input);
    await assert.rejects(session.post(plan.id, plan.input, fields), /lost binding/);
    const id = f.store.load()!.id!; assert(id);
    const restoredStore = new FilePending(path.join(f.dir, 'pending.json')); await restoredStore.initialize();
    const restored = new ReviewSession(f.root, new GitAdapter(), f.factory, restoredStore);
    assert.equal((await restored.reconcile())?.id, id); assert.equal(restoredStore.load(), undefined);
    const browser = new ReviewBrowser(f.factory), request = new RequestSession(f.factory, { load: () => undefined, save: async () => {} });
    await labApi(`/review-requests/${id}/draft/`, 'PUT', new URLSearchParams({ commit_id: 'e'.repeat(40), update_from_commit_id: 'false' }));
    await assert.rejects(request.publish(await browser.open(f.server, id)), /Commit ID/);
    assert(!(await f.factory(f.server).snapshot(id)).review.public);
    await labApi(`/review-requests/${id}/draft/`, 'PUT', new URLSearchParams({ commit_id: plan.git.head, update_from_commit_id: 'false' }));
    await request.publish(await browser.open(f.server, id));
    await writeFile(path.join(f.root, 'feature.txt'), 'updated by another client\n'); await git(f.root, 'add', 'feature.txt'); await git(f.root, 'commit', '-m', randomUUID());
    const update = await restored.preview({ ...input, reviewId: id });
    await f.factory(f.server).post({ ...update, bindingVersion: undefined }, fields);
    await assert.rejects(request.publish(await browser.open(f.server, id)), /no HEAD binding/);
    assert((await f.factory(f.server).snapshot(id)).draft); await f.cleanup();
});

test('commit ownership prevents duplicate uploads and upgrades legacy conflicted drafts without retrying the binding', { timeout: 90_000 }, async () => {
    const f = await setup('feature/merged-side'), first = new ReviewSession(f.root, new GitAdapter(), f.factory, f.store), plan = await first.preview(input);
    const original = await first.post(plan.id, plan.input, fields);
    const otherStore = new FilePending(path.join(f.dir, 'conflict.json')); await otherStore.initialize();
    const other = new ReviewSession(f.root, new GitAdapter(), f.factory, otherStore), duplicate = await other.preview(input);
    const adapter = f.factory(f.server), before = (await adapter.list<{ id: number }>('/review-requests/', 'review_requests', { 'from-user': 'admin', repository: '1', status: 'all' })).map(review => review.id);
    await assert.rejects(other.post(duplicate.id, duplicate.input, fields), CommitConflictError);
    assert.equal(other.conflict?.requests[0]?.id, original.id);
    assert.equal(otherStore.load(), undefined);
    assert.deepEqual((await adapter.list<{ id: number }>('/review-requests/', 'review_requests', { 'from-user': 'admin', repository: '1', status: 'all' })).map(review => review.id), before);
    // Simulate an old client that uploaded before checking HEAD ownership.
    const id = await adapter.post(duplicate, fields), checkpoint = await adapter.snapshot(id);
    const uploadedDiffs = (await adapter.list<ServerDiff>(`/review-requests/${id}/draft/diffs/`, 'diffs')).map(diff => diff.id);
    await otherStore.save({ kind: 'post', plan: duplicate, fields, id, bindingCheckpoint: checkpoint });
    let writes = 0;
    class Watched extends RBToolsAdapter { override async replaceFields(...args: Parameters<RBToolsAdapter['replaceFields']>): Promise<void> { writes++; await super.replaceFields(...args); } }
    const restored = new ReviewSession(f.root, new GitAdapter(), address => new Watched(f.root, f.factory(address).options), otherStore);
    await assert.rejects(restored.reconcile(), CommitConflictError); assert.equal(otherStore.load()?.commitConflict?.requests[0]?.id, original.id);
    await assert.rejects(restored.completeBinding(), CommitConflictError); await assert.rejects(restored.reconcile(), CommitConflictError);
    assert.equal(writes, 0); assert.equal(otherStore.load()?.id, id); assert.equal((await adapter.snapshot(id)).review.public, false);
    assert.equal((await adapter.snapshot(original.id)).draft?.commit_id, plan.git.head);
    assert.deepEqual((await adapter.list<ServerDiff>(`/review-requests/${id}/draft/diffs/`, 'diffs')).map(diff => diff.id), uploadedDiffs);
    await assert.rejects(other.post(duplicate.id, duplicate.input, fields), /待确认/);
    await f.cleanup();
});

test('a real API 227 raced after preflight becomes a persistent conflict and never repeats the binding write', { timeout: 90_000 }, async () => {
    const f = await setup('feature/merged-side'), original = new ReviewSession(f.root, new GitAdapter(), f.factory, f.store), plan = await original.preview(input);
    const first = await original.post(plan.id, plan.input, fields), adapter = f.factory(f.server), before = await adapter.snapshot(first.id);
    let reads = 0, writes = 0;
    class Raced extends RBToolsAdapter {
        override async commitRequests(...args: Parameters<RBToolsAdapter['commitRequests']>): ReturnType<RBToolsAdapter['commitRequests']> { return ++reads <= 2 ? [] : super.commitRequests(...args); }
        override async replaceFields(...args: Parameters<RBToolsAdapter['replaceFields']>): Promise<void> { writes++; await super.replaceFields(...args); }
    }
    const store = new FilePending(path.join(f.dir, 'race.json')); await store.initialize();
    const raced = new ReviewSession(f.root, new GitAdapter(), address => new Raced(f.root, f.factory(address).options), store), preview = await raced.preview(input);
    await assert.rejects(raced.post(preview.id, preview.input, fields), CommitConflictError);
    assert.equal(writes, 1); assert.equal(store.load()?.commitConflict?.requests[0]?.id, first.id);
    await assert.rejects(raced.completeBinding(), CommitConflictError); await assert.rejects(raced.reconcile(), CommitConflictError);
    assert.equal(writes, 1); assert.equal((await adapter.snapshot(first.id)).fingerprint, before.fingerprint);
    assert.equal((await adapter.snapshot(store.load()!.id!)).review.public, false); await f.cleanup();
});

test('legacy history requests remain readable, publishable and reviewable; nonlinear history updates give an actionable error', { timeout: 100_000 }, async () => {
    const f = await setup('feature/linear'), session = new ReviewSession(f.root, new GitAdapter(), f.factory, f.store), plan = await session.preview(input), adapter = f.factory(f.server);
    const result = JSON.parse((await adapter.command(['post', '--json', '--disable-cache', '--repository-type=git', `--repository=${plan.repository.name}`,
        '--with-history', '--guess-fields=no', `--tracking-branch=${input.targetRef}`, '--summary=Legacy history compatibility'], undefined,
        { '--description-file': fields.description }, [plan.git.base, plan.git.head])).toString()) as { review_request_id: number };
    const id = result.review_request_id; assert(id);
    const legacyPlan = { ...plan, bindingVersion: undefined, input: { ...plan.input, mode: 'history' as const } };
    await adapter.replaceFields(legacyPlan, fields, id);
    const browser = new ReviewBrowser(f.factory), draft = await browser.open(f.server, id); assert(draft.review.created_with_history);
    await git(f.root, 'switch', '--detach', 'origin/main');
    await new RequestSession(f.factory, { load: () => undefined, save: async () => {} }).publish(draft);
    const token = (JSON.parse(await readFile(path.join(project, 'build/reviewer-token.json'), 'utf8')) as { token: string }).token;
    const reviewer = (address: string) => new RBToolsAdapter(f.root, { ...f.factory(address).options, token: async () => token });
    const comparison = await new ReviewBrowser(reviewer).open(f.server, id); assert(comparison.files.length);
    let writing: ReviewWrite | undefined;
    const feedback = new FeedbackSession(reviewer, { load: () => writing, save: async value => { writing = value; } });
    const text = { body: 'Legacy history remains reviewable', shipIt: false, comments: [] };
    await feedback.save(comparison, text); assert.equal((await feedback.publish(comparison, text)).published, true);
    await git(f.root, 'switch', '--detach', 'feature/merged'); await uniqueFixtureHead(f.root);
    await assert.rejects(session.preview({ ...input, reviewId: id }), /history request needs a linear branch/);
    assert((await adapter.snapshot(id)).review.created_with_history); await f.cleanup();
});

test('three explicit diff modes preserve their transport and commit identity on the real server', { timeout: 150_000 }, async () => {
    for (const mode of ['bound', 'squash', 'history'] as const) {
        const f = await setup('feature/linear'), adapter = f.factory(f.server);
        const targetRef = 'aaa/fea_bbb';
        await git(f.root, 'branch', targetRef, input.targetRef);
        const session = new ReviewSession(f.root, new GitAdapter(), f.factory, f.store), plan = await session.preview({ ...input, mode, targetRef });
        assert.equal(plan.input.mode, mode); assert.equal(plan.bindingVersion, mode === 'bound' ? 1 : undefined);
        const saved = await session.post(plan.id, plan.input, fields), remote = await new ReviewBrowser(f.factory).open(f.server, saved.id);
        assert.equal(remote.details.branch, targetRef);
        assert.equal(remote.submissionMode, mode); assert.equal(remote.review.created_with_history, mode === 'history');
        const diff = (await adapter.api<{ diff: ServerDiff }>(`/review-requests/${saved.id}/draft/diffs/1/`)).diff;
        assert.equal(!!readBinding(diff.extra_data?.[bindingKey]), mode === 'bound');
        if (mode === 'bound') { assert.equal(remote.details.commit_id, plan.git.head); }
        if (mode === 'squash') { assert.notEqual(remote.details.commit_id, plan.git.head); }
        if (mode === 'history') { assert((diff.commit_count ?? 0) > 0); }
        await new RequestSession(f.factory, { load: () => undefined, save: async () => {} }).publish(remote);
        assert.equal((await adapter.snapshot(saved.id)).review.branch, targetRef);
        await git(f.root, 'branch', '-d', targetRef);
        await f.cleanup();
    }
});

test('a reordered preview verifies against the server without weakening the publish gate', { timeout: 90_000 }, async () => {
    const f = await setup();
    class ReorderedPreview extends RBToolsAdapter {
        override async diff(...args: Parameters<RBToolsAdapter['diff']>): Promise<Buffer> {
            const patch = await super.diff(...args);
            const blocks = patch.toString('latin1').replace(/\n+$/, '').split(/\n(?=diff --git )/);
            assert(blocks.length > 1);
            return Buffer.from(blocks.reverse().join('\n') + '\n', 'latin1');
        }
    }
    const factory = (server: string) => new ReorderedPreview(f.root, f.factory(server).options);
    const session = new ReviewSession(f.root, new GitAdapter(), factory, f.store);
    const plan = await session.preview(input);
    assert.equal(plan.patchHash, patchDigest(session.patch!));
    const saved = await session.post(plan.id, plan.input, fields);
    const adapter = f.factory(f.server);
    assert.notEqual(await adapter.patchHash(saved.id, saved.diffRevision, 'draft'), plan.patchHash);
    const remote = await new ReviewBrowser(f.factory).open(f.server, saved.id);
    assert((await new RequestSession(f.factory, { load: () => undefined, save: async () => {} }).publish(remote)).published);
    await f.cleanup();
});
