import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { RBToolsAdapter } from '../adapters/rbtools';
import { GitAdapter } from '../adapters/git';
import { ReviewSession } from '../application/reviewSession';
import { ReviewBrowser } from '../application/reviewBrowser';
import { RequestSession } from '../application/requestSession';
import { DiscussionSession } from '../application/discussionSession';
import { InboxSession, InboxStore } from '../application/inboxSession';
import { StateStorage } from '../application/repositoryStore';
import { isUnread } from '../domain/inbox';
import { FilePending, fields, git, input, labApi, labRoot, project, rbtPath, temporary } from './helpers';

test('real public discussion, every comment type and replies; historical diff identity; direct/group inbox and persistent read versions', { timeout: 240_000 }, async () => {
    const dir = await temporary('collaboration-'), root = path.join(dir, 'worktree'), server = 'http://127.0.0.1:8080/';
    await git(labRoot, 'worktree', 'add', '--detach', root, 'feature/stacked-parent');
    await copyFile(path.join(labRoot, '.reviewboardrc'), path.join(root, '.reviewboardrc'));
    await writeFile(path.join(root, 'parent.txt'), 'one\ntwo\nthree\n'); await git(root, 'add', 'parent.txt'); await git(root, 'commit', '-m', 'Discussion fixture');
    const token = (JSON.parse(await readFile(path.join(project, 'build/reviewer-token.json'), 'utf8')) as { token: string }).token;
    const author = (server: string) => new RBToolsAdapter(root, { executable: rbtPath, storage: dir, server });
    const reviewer = (address: string) => new RBToolsAdapter(root, { executable: rbtPath, storage: dir, server: address || server, token: async () => token });
    const pending = new FilePending(path.join(dir, 'post.json')); await pending.initialize();
    const submission = new ReviewSession(root, new GitAdapter(), author, pending);
    const plan = await submission.preview(input), metadata = { ...fields, summary: 'Comments and inbox acceptance', groups: [], description: 'Public discussion acceptance' };
    const receipt = await submission.post(plan.id, plan.input, metadata), id = receipt.id;
    const attachmentForm = new FormData(); attachmentForm.set('path', new Blob(['Attachment contents']), 'notes.txt'); attachmentForm.set('caption', 'Notes');
    const attachment = await labApi<{ file_attachment: { id: number } }>(`/review-requests/${id}/file-attachments/`, 'POST', attachmentForm);
    const screenshotForm = new FormData(); screenshotForm.set('path', new Blob([new Uint8Array(await readFile(path.join(project, 'media/logo.png')))], { type: 'image/png' }), 'review.png'); screenshotForm.set('caption', 'Screenshot');
    const screenshot = await labApi<{ screenshot: { id: number } }>(`/review-requests/${id}/screenshots/`, 'POST', screenshotForm);
    const ownerBrowser = new ReviewBrowser(author), otherBrowser = new ReviewBrowser(reviewer);
    const writes = new RequestSession(author, { load: () => undefined, save: async () => {} });
    await writes.publish(await ownerBrowser.open(server, id));
    const initial = await otherBrowser.open(server, id), file = initial.files.find(file => file.path === 'parent.txt')!; assert(file);
    const text = {
        header: 'Overall review header\nSecond line', footer: 'Overall review footer', general: 'General issue: explain behavior', diff: 'Line two needs a clearer name',
        attachment: 'Attachment comment text', screenshot: 'Screenshot region comment', replyHeader: 'Author reply header', replyFooter: 'Author reply footer',
        diffReply: 'Diff reply addressed', generalReply: 'General reply explained', attachmentReply: 'Attachment reply', screenshotReply: 'Screenshot reply',
        private: 'PRIVATE unpublished text must stay hidden',
    };
    const review = (await labApi<{ review: { id: number } }>(`/review-requests/${id}/reviews/`, 'POST', new URLSearchParams({ body_top: text.header, body_bottom: text.footer, ship_it: 'true' }), 'reviewer')).review;
    const prefix = `/review-requests/${id}/reviews/${review.id}/`;
    const comments: Record<string, number> = {};
    const types = [
        ['general', 'general_comment', { text: text.general, issue_opened: 'true' }],
        ['diff', 'diff_comment', { text: text.diff, filediff_id: String(file.id), first_line: '2', num_lines: '1', issue_opened: 'true' }],
        ['file-attachment', 'file_attachment_comment', { text: text.attachment, file_attachment_id: String(attachment.file_attachment.id) }],
        ['screenshot', 'screenshot_comment', { text: text.screenshot, screenshot_id: String(screenshot.screenshot.id), x: '1', y: '1', w: '10', h: '10' }],
    ] as const;
    for (const [kind, key, values] of types) {
        comments[kind] = (await labApi<Record<string, { id: number }>>(prefix + kind + '-comments/', 'POST', new URLSearchParams(values), 'reviewer'))[key]!.id;
    }
    await labApi(prefix, 'PUT', new URLSearchParams({ public: 'true' }), 'reviewer');
    const reply = (await labApi<{ reply: { id: number } }>(prefix + 'replies/', 'POST', new URLSearchParams({ body_top: text.replyHeader, body_bottom: text.replyFooter }))).reply;
    const replyPrefix = prefix + `replies/${reply.id}/`;
    for (const [kind, replyText] of [['general', text.generalReply], ['diff', text.diffReply], ['file-attachment', text.attachmentReply], ['screenshot', text.screenshotReply]]) {
        await labApi(replyPrefix + kind + '-comments/', 'POST', new URLSearchParams({ text: replyText!, reply_to_id: String(comments[kind!]) }));
    }
    await labApi(replyPrefix, 'PUT', new URLSearchParams({ public: 'true' }));
    await labApi(prefix + 'replies/', 'POST', new URLSearchParams({ body_top: text.private }));
    await labApi(`/review-requests/${id}/reviews/`, 'POST', new URLSearchParams({ body_top: text.private }), 'reviewer');
    await writeFile(path.join(root, 'parent.txt'), 'one\ntwo improved\nthree\n'); await git(root, 'add', 'parent.txt'); await git(root, 'commit', '-m', 'Address comments in revision two');
    const update = await submission.preview({ ...input, reviewId: id }); await submission.post(update.id, update.input, metadata);
    await submission.publish(submission.plan!.id, submission.plan!.input, metadata);
    const current = await ownerBrowser.open(server, id), discussion = new DiscussionSession(author), index = await discussion.index(current);
    assert.equal(current.selected.revision, 2); assert.equal(index.reviews.length, 1);
    const bundle = await discussion.bundle(index, index.reviews[0]!);
    assert.deepEqual(new Set(bundle.messages.map(message => message.kind)), new Set(['header', 'footer', 'general', 'diff', 'attachment', 'screenshot']));
    const inline = bundle.messages.find(message => message.kind === 'diff')!;
    assert.equal(inline.location?.revision, 1); assert.equal(inline.location.fileId, file.id); assert.equal(inline.path, 'parent.txt');
    assert.equal(inline.issue, 'open'); assert.equal(bundle.replies.length, 1);
    const transcript = await discussion.transcript(current);
    for (const [key, value] of Object.entries(text)) { if (key !== 'private') { assert(transcript.includes(value), key + ' is readable'); } }
    assert(!transcript.includes(text.private)); assert(transcript.includes('Ship It'));
    const stateData: Record<string, unknown> = {}, storage: StateStorage = { get: <T>(key: string) => structuredClone(stateData[key]) as T | undefined,
        update: async (key, value) => { stateData[key] = structuredClone(value); } };
    const store = new InboxStore(storage), inbox = new InboxSession(reviewer, store), first = await inbox.refresh(server);
    const entry = first.state.entries.find(entry => entry.id === id)!; assert(entry); assert(isUnread(first.state, entry)); assert.deepEqual(first.arrivals, []);
    await store.mark(first.state.identity, [entry], true);
    assert(!isUnread(new InboxStore(storage).get(first.state.identity), entry));
    await writes.edit(await ownerBrowser.open(server, id), { description: 'Published content update for the inbox', people: [], groups: ['reviewers'] });
    await writes.publish(await ownerBrowser.open(server, id));
    const changed = await inbox.refresh(server), updated = changed.state.entries.find(entry => entry.id === id)!;
    assert(updated.viaGroup); assert(isUnread(changed.state, updated)); assert.deepEqual(changed.arrivals.map(entry => entry.id), [id]);
    assert.deepEqual((await inbox.refresh(server)).arrivals, []);
    await store.mark(first.state.identity, [entry], true); assert(isUnread(store.get(first.state.identity), updated));
    // A separate author provides an actionable incoming request for the real native Host test.
    const otherPending = new FilePending(path.join(dir, 'other.json')); await otherPending.initialize();
    const other = new ReviewSession(root, new GitAdapter(), reviewer, otherPending), otherPlan = await other.preview(input);
    const incomingFields = { ...metadata, people: ['admin'], groups: [], summary: 'Incoming review for native inbox', description: 'Waiting for native inbox review' };
    const incoming = await other.post(otherPlan.id, otherPlan.input, incomingFields); await other.publish(other.plan!.id, other.plan!.input, incomingFields);
    await writeFile(path.join(project, 'build/collaboration-fixture.json'), JSON.stringify({ requestId: id, reviewId: review.id, inboxRequestId: incoming.id, server, text,
        oldFileId: file.id, oldRevision: 1, commentVirtualLine: 2 }, null, 2) + '\n');
    await git(labRoot, 'worktree', 'remove', '--force', root);
});
