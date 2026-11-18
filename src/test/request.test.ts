import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { copyFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ApiError, RBToolsAdapter } from '../adapters/rbtools';
import { ProcessError } from '../adapters/process';
import { GitAdapter } from '../adapters/git';
import { ReviewSession } from '../application/reviewSession';
import { ReviewBrowser } from '../application/reviewBrowser';
import { RequestSession, RequestWrite } from '../application/requestSession';
import { PublishValidationError } from '../domain/model';
import { FilePending, fields, git, input, labPage, labRoot, rbtPath, temporary, uniqueFixtureHead } from './helpers';

test('request lifecycle on a separate checkout: edit, publish, discard and recover lost responses', { timeout: 150_000 }, async () => {
    const dir = await temporary('request-'), checkout = path.join(dir, 'unrelated-checkout'), root = path.join(dir, 'author');
    await git(labRoot, 'worktree', 'add', '--detach', root, 'feature/merged');
    await copyFile(path.join(labRoot, '.reviewboardrc'), path.join(root, '.reviewboardrc')); await uniqueFixtureHead(root);
    const factory = (server: string) => new RBToolsAdapter(root, { executable: rbtPath, storage: dir, server });
    const adapter = factory(''), gitAdapter = new GitAdapter();
    const store = new FilePending(path.join(dir, 'post.json')); await store.initialize();
    const session = new ReviewSession(root, gitAdapter, factory, store), plan = await session.preview(input);
    const raw = await gitAdapter.commitMessage(root, plan.git.base, plan.git.head), guessed = await adapter.guessMessage(raw);
    const firstSubject = (await git(root, 'log', '--reverse', '--format=%s', `${plan.git.base}..${plan.git.head}`)).toString().split('\n')[0];
    assert.equal(guessed.summary, firstSubject); assert(guessed.description?.trim());
    const noReviewers = { ...fields, summary: guessed.summary!, description: guessed.description!, people: [], groups: [] };
    const saved = await session.post(plan.id, plan.input, noReviewers);
    await assert.rejects(session.publish(session.plan!.id, session.plan!.input, noReviewers), error => error instanceof PublishValidationError && error.field === 'reviewers');
    assert.equal(store.load(), undefined);
    await assert.rejects(factory(plan.server).publish(saved.id), error => error instanceof ApiError && error.code === 225);
    assert.equal((await factory(plan.server).snapshot(saved.id)).review.public, false);
    await store.save({ kind: 'publish', plan: session.plan!, fields: noReviewers, id: saved.id });
    const restored = new ReviewSession(labRoot, gitAdapter, factory, store);
    assert.equal((await restored.reconcile())?.published, false); assert.equal(store.load(), undefined);
    await git(labRoot, 'worktree', 'add', '--detach', checkout, 'origin/main');
    await copyFile(path.join(labRoot, '.reviewboardrc'), path.join(checkout, '.reviewboardrc'));
    const remoteFactory = (server: string) => new RBToolsAdapter(checkout, { executable: rbtPath, storage: dir, server });
    const browser = new ReviewBrowser(remoteFactory);
    let pending: RequestWrite | undefined;
    const journal = { load: () => pending, save: async (value: RequestWrite | undefined) => {
        pending = value; await writeFile(path.join(dir, 'request-journal.json'), JSON.stringify(value ?? null));
    } };
    const request = new RequestSession(remoteFactory, journal), comparison = await browser.open(plan.server, saved.id);
    await assert.rejects(request.publish(comparison), PublishValidationError); assert.equal(pending, undefined);
    await request.edit(comparison, { people: ['reviewer'] }); assert.equal(pending, undefined);
    await assert.rejects(request.edit(comparison, { bugs: ['STALE'] }), /changed/); assert.equal(pending, undefined);
    const updated = await browser.open(plan.server, saved.id);
    class Rejected extends RBToolsAdapter { override async publish(): Promise<void> { throw new ApiError('Injected definitive publish rejection', 225); } }
    const rejected = new RequestSession(server => new Rejected(checkout, { executable: rbtPath, storage: dir, server }), journal);
    await assert.rejects(rejected.publish(updated), /definitive/); assert.equal(pending, undefined);
    const beforeVisit = await remoteFactory(plan.server).snapshot(saved.id);
    assert.equal(await labPage(saved.id), 200);
    const afterVisit = await remoteFactory(plan.server).snapshot(saved.id);
    assert.equal(afterVisit.review.extra_data.calculated_trophies, true);
    assert.equal(beforeVisit.fingerprint, afterVisit.fingerprint, 'A read-only browser visit must not invalidate publication');
    assert.equal((await request.publish(updated)).published, true);
    const published = await browser.open(plan.server, saved.id); assert.equal(published.selected.scope, 'published');
    await request.edit(published, { bugs: ['METADATA-2'] });
    const metadataOnly = await browser.open(plan.server, saved.id);
    assert(metadataOnly.requestSnapshot?.draft); assert.equal(metadataOnly.selected.scope, 'published');
    assert.deepEqual(metadataOnly.details.bugs_closed, ['METADATA-2']);
    class LostResponse extends RBToolsAdapter {
        override async publish(id: number, signal?: AbortSignal): Promise<void> {
            await super.publish(id, signal); throw new ProcessError('Injected lost publish response', Buffer.alloc(0), Buffer.alloc(0), 'exit');
        }
    }
    const lost = new RequestSession(server => new LostResponse(checkout, { executable: rbtPath, storage: dir, server }), journal);
    await assert.rejects(lost.publish(metadataOnly), /lost publish/); assert(pending);
    assert.equal((await new RequestSession(remoteFactory, journal).reconcile())?.published, true); assert.equal(pending, undefined);

    const publishedBeforeDiscard = await browser.open(plan.server, saved.id);
    await request.edit(publishedBeforeDiscard, { bugs: ['DISCARD-ME'] });
    await assert.rejects(request.discard(publishedBeforeDiscard), /Request content changed/);
    const draftToDiscard = await browser.open(plan.server, saved.id);
    class LostDiscardResponse extends RBToolsAdapter {
        override async discardRequest(...args: Parameters<RBToolsAdapter['discardRequest']>): Promise<void> {
            await super.discardRequest(...args);
            throw new ProcessError('Injected lost discard response', Buffer.alloc(0), Buffer.alloc(0), 'exit');
        }
    }
    const lostDiscard = new RequestSession(server => new LostDiscardResponse(checkout, { executable: rbtPath, storage: dir, server }), journal);
    await assert.rejects(lostDiscard.discard(draftToDiscard), /lost discard/);
    assert.equal((journal.load() as RequestWrite | undefined)?.kind, 'discard');
    assert.equal((await request.reconcile())?.applied, true);
    assert.equal(journal.load(), undefined);
    const afterDiscard = await browser.open(plan.server, saved.id);
    assert.equal(afterDiscard.requestSnapshot?.draft, null);
    assert.equal(afterDiscard.review.status, 'pending');
    assert.deepEqual(afterDiscard.details.bugs_closed, ['METADATA-2']);
    assert.equal(afterDiscard.selected.id, publishedBeforeDiscard.selected.id);
    assert.equal((await request.discard(afterDiscard)).applied, true);
    assert.equal((await adapter.snapshot(saved.id)).review.status, 'discarded');

    await uniqueFixtureHead(root);
    const newPlan = await session.preview(input);
    const newDraft = await session.post(newPlan.id, newPlan.input, fields);
    await request.discard(await browser.open(newPlan.server, newDraft.id));
    const closed = await adapter.snapshot(newDraft.id);
    assert.equal(closed.review.status, 'discarded');
    assert.equal(closed.review.public, false);
    await git(labRoot, 'worktree', 'remove', '--force', checkout);
    await git(labRoot, 'worktree', 'remove', '--force', root);
});
