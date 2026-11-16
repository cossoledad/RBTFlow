import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { RBToolsAdapter } from '../adapters/rbtools';
import { GitAdapter } from '../adapters/git';
import { ProcessError } from '../adapters/process';
import { ReviewSession } from '../application/reviewSession';
import { ReviewBrowser } from '../application/reviewBrowser';
import { FeedbackSession } from '../application/feedbackSession';
import { ReviewWrite, virtualRange } from '../domain/comparison';
import { FilePending, fields, git, input, labRoot, project, rbtPath, temporary } from './helpers';

async function reviewerToken(): Promise<string> {
    const filename = path.join(project, 'build/reviewer-token.json');
    try { return (JSON.parse(await readFile(filename, 'utf8')) as { token: string }).token; } catch { /* local lab only */ }
    const response = await fetch('http://127.0.0.1:8080/api/users/reviewer/api-tokens/', { method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from('reviewer:rbtflow-local').toString('base64')}` },
        body: new URLSearchParams({ note: 'RBTFlow local review tests', policy: '{}' }) });
    const result = await response.json() as { api_token?: { token: string } };
    assert(result.api_token?.token, 'Local reviewer token created');
    await writeFile(filename, JSON.stringify({ token: result.api_token.token }), { mode: 0o600 });
    return result.api_token.token;
}

test('published/draft comparisons, another reviewer, exact inline rows, approval and lost-response recovery', { timeout: 180_000 }, async () => {
    const dir = await temporary('review-'), root = path.join(dir, 'worktree');
    await git(labRoot, 'worktree', 'add', '--detach', root, 'feature/stacked-parent');
    await copyFile(path.join(labRoot, '.reviewboardrc'), path.join(root, '.reviewboardrc'));
    await writeFile(path.join(root, 'parent.txt'), 'A\nB\nC\nD\n'); await git(root, 'add', 'parent.txt'); await git(root, 'commit', '-m', 'Review baseline');
    const base = (await git(root, 'rev-parse', 'HEAD')).toString().trim();
    await writeFile(path.join(root, 'parent.txt'), 'A\nD\nE\n'); await git(root, 'add', 'parent.txt'); await git(root, 'commit', '-m', 'Delete lines then extend');
    const firstHead = (await git(root, 'rev-parse', 'HEAD')).toString().trim();
    const token = await reviewerToken();
    const author = (server: string) => new RBToolsAdapter(root, { executable: rbtPath, storage: dir, server });
    const reviewer = (server: string) => new RBToolsAdapter(root, { executable: rbtPath, storage: dir, server: server || 'http://127.0.0.1:8080/', token: async () => token });
    assert.equal(await reviewer('').username(), 'reviewer');
    const pending = new FilePending(path.join(dir, 'post.json')); await pending.initialize();
    const submission = new ReviewSession(root, new GitAdapter(), author, pending);
    const plan = await submission.preview({ ...input, baseRef: base });
    const saved = await submission.post(plan.id, plan.input, fields), id = saved.id;
    const ownerBrowser = new ReviewBrowser(author), otherBrowser = new ReviewBrowser(reviewer);
    const draft = await ownerBrowser.open(plan.server, id);
    assert.equal(draft.selected.scope, 'draft'); assert.equal(draft.details.summary, fields.summary);
    await assert.rejects(otherBrowser.open(plan.server, id));
    await submission.publish(submission.plan!.id, submission.plan!.input, fields);
    await git(root, 'switch', '--detach', 'origin/main');
    const comparison = await otherBrowser.open(plan.server, id);
    assert.equal(comparison.review.links.submitter!.title, 'admin'); assert.equal(comparison.username, 'reviewer');
    assert(comparison.versions.every(version => version.scope === 'published'));
    const file = comparison.files.find(item => item.path === 'parent.txt')!;
    assert(file);
    assert.equal((await reviewer(plan.server).comparisonData(comparison, file.id, 'base')).toString(), 'A\nB\nC\nD\n');
    assert.equal((await reviewer(plan.server).comparisonData(comparison, file.id, 'head')).toString(), 'A\nD\nE\n');
    const map = await reviewer(plan.server).lines(comparison, file.id), range = virtualRange(map, 'head', 2, 2);
    assert.deepEqual(range, { firstLine: 4, numLines: 1 });
    let writing: ReviewWrite | undefined;
    const store = { load: () => writing, save: async (value: ReviewWrite | undefined) => { writing = value; await writeFile(path.join(dir, 'review-write.json'), JSON.stringify(value ?? null)); } };
    const feedback = new FeedbackSession(reviewer, store);
    const body = { body: 'Reviewed independent server snapshots', shipIt: true,
        comments: [{ id: randomUUID(), fileId: file.id, side: 'head' as const, ...range, text: 'D is the retained destination line', issueOpened: false }] };
    const reviewDraft = await feedback.save(comparison, body);
    assert.equal(reviewDraft.published, false);
    assert.equal((await feedback.publish(comparison, body)).published, true);
    const comments = await reviewer(plan.server).fileComments(comparison, file.id);
    assert(comments.some(comment => comment.public && comment.first_line === 4 && comment.links.user?.title === 'reviewer'));
    const second = await otherBrowser.open(plan.server, id);
    const nextBody = { body: 'Review awaiting the next update', shipIt: false, comments: [] };
    await feedback.save(second, nextBody);
    await git(root, 'switch', '--detach', firstHead);
    await writeFile(path.join(root, 'parent.txt'), 'A\nD\nE2\n'); await git(root, 'add', 'parent.txt'); await git(root, 'commit', '-m', 'Address review');
    const update = await submission.preview({ ...input, baseRef: base, reviewId: id });
    await submission.post(update.id, update.input, fields);
    const ownPending = await ownerBrowser.open(plan.server, id);
    assert.equal(ownPending.selected.scope, 'draft'); assert.equal(ownPending.selected.revision, 2);
    const stillPublished = await otherBrowser.open(plan.server, id);
    assert.equal(stillPublished.selected.revision, 1); assert(stillPublished.versions.every(version => version.scope === 'published'));
    await submission.publish(submission.plan!.id, submission.plan!.input, fields);
    await assert.rejects(feedback.publish(second, nextBody), /新版本/);
    assert.equal(store.load(), undefined);
    const latest = await otherBrowser.open(plan.server, id);
    assert.equal(latest.selected.revision, 2);
    const historical = await otherBrowser.open(plan.server, id, { scope: 'published', revision: 1 });
    const historicalFile = historical.files.find(item => item.path === 'parent.txt')!;
    assert.equal((await reviewer(plan.server).comparisonData(historical, historicalFile.id, 'head')).toString(), 'A\nD\nE\n');
    await feedback.save(latest, nextBody); await feedback.publish(latest, nextBody);
    const recoverComparison = await otherBrowser.open(plan.server, id);
    class LostReviewResponse extends RBToolsAdapter {
        override async writeReview(...args: Parameters<RBToolsAdapter['writeReview']>): Promise<number> {
            await super.writeReview(...args); throw new ProcessError('Injected review response loss', Buffer.alloc(0), Buffer.alloc(0), 'exit');
        }
    }
    const lost = (server: string) => new LostReviewResponse(root, { executable: rbtPath, storage: dir, server, token: async () => token });
    const failed = new FeedbackSession(lost, store);
    const recoverBody = { body: 'Saved before response was lost', shipIt: false, comments: [] };
    await assert.rejects(failed.save(recoverComparison, recoverBody), /Injected/); assert(store.load());
    const restored = new FeedbackSession(reviewer, store);
    assert((await restored.reconcile())?.id); assert.equal(store.load(), undefined);
    const alternatePending = new FilePending(path.join(dir, 'reviewer-post.json')); await alternatePending.initialize();
    const alternate = new ReviewSession(root, new GitAdapter(), reviewer, alternatePending);
    const alternatePlan = await alternate.preview({ ...input, baseRef: base });
    const alternateFields = { ...fields, summary: 'Review another author in the VS Code sidebar' };
    const alternateReceipt = await alternate.post(alternatePlan.id, alternatePlan.input, alternateFields);
    await alternate.publish(alternate.plan!.id, alternate.plan!.input, alternateFields);
    await writeFile(path.join(project, 'build/review-test-fixture.json'), JSON.stringify({ requestId: id, alternateRequestId: alternateReceipt.id,
        server: plan.server, virtualLine: 4, filePath: 'parent.txt', expectedHead: 'A\nD\nE2\n' }, null, 2) + '\n');
    await git(labRoot, 'worktree', 'remove', '--force', root);
});
