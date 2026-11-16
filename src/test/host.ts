import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { RBTFlowAPI } from '../extension';
import { fields, labRoot, project, rbtPath } from './helpers';

async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!check()) {
        if (Date.now() > deadline) { throw new Error('Timed out waiting for actual VS Code webview render'); }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

export async function run(): Promise<void> {
    const checks: string[] = [];
    const extension = vscode.extensions.getExtension<RBTFlowAPI>('cossoledad.rbtflow');
    assert(extension);
    const api = await extension.activate();
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    assert(api.roots().includes(labRoot));
    checks.push('activate-and-discover-repository');
    let panel = await api.open(labRoot);
    assert(panel);
    await waitFor(() => api.sidebar.webviewReady);
    checks.push('webview-script-loaded-under-csp');
    await panel.handleMessage({ type: 'preview', form: { ...panel.form, ...fields, reviewId: null, mode: 'squash' } });
    assert(panel.session.plan, JSON.stringify(panel.getState()));
    const plan = panel.session.plan;
    await waitFor(() => api.sidebar.renderedState?.comparisonId === plan.id && !!api.sidebar.renderedState.canPost);
    assert.equal(api.changes.getChildren().length, plan.git.files.length);
    assert.equal(api.sidebar.renderedState!.canPublish, false);
    checks.push('real-preview-rendered-files-and-submit-state');
    const index = plan.git.files.findIndex(file => file.status === 'M');
    await api.sidebar.openChange(api.changes.getChildren()[index]!);
    const documents = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'rbtflow');
    assert(documents.some(document => document.getText() === 'base\n'));
    assert(documents.some(document => document.getText() === 'feature greeting\n'));
    assert(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputTextDiff));
    checks.push('native-diff-opens-exact-base-head-snapshots');
    await api.open(labRoot);
    await panel.handleMessage({ type: 'post', planId: plan.id, form: panel.form });
    assert(panel.session.receipt, JSON.stringify(panel.getState()));
    assert.equal(panel.session.receipt.published, false);
    await waitFor(() => !!api.sidebar.renderedState?.canPublish);
    checks.push('webview-dispatch-saves-real-review-draft');
    const originalServer = panel.form.server, id = panel.session.receipt.id;
    await panel.session.pendingStore.save({ kind: 'post', plan: panel.session.plan!, fields, id });
    await panel.handleMessage({ type: 'edit', form: { ...panel.form, server: 'http://different.invalid/' } });
    await panel.handleMessage({ type: 'reconcile', form: panel.form });
    assert.equal(panel.form.server, originalServer, JSON.stringify(panel.getState()));
    assert.equal(panel.form.reviewId, id);
    assert.equal(panel.session.pending, undefined);
    checks.push('recovery-restores-the-original-server-and-review-binding');
    await panel.handleMessage({ type: 'preview', form: panel.form });
    assert(panel.session.plan, JSON.stringify(panel.getState()));
    await panel.handleMessage({ type: 'post', planId: panel.session.plan.id, form: panel.form });
    assert.equal(panel.session.receipt?.id, id, JSON.stringify(panel.getState()));
    const saved = panel.session.plan!;
    await panel.handleMessage({ type: 'publish', planId: saved.id, form: panel.form });
    assert.equal(panel.session.receipt.published, true, JSON.stringify(panel.getState()));
    const submissionReceipt = panel.session.receipt;
    checks.push('separate-publish-action-verifies-server-result');
    const ownForm = structuredClone(panel.form), defaults = panel.store.newForm();
    await panel.store.set('settings', { rbtPath, timeoutSeconds: 90 });
    await panel.handleMessage({ type: 'openRemote', reviewId: id });
    assert.equal(panel.browser.current?.review.links.submitter?.title, 'admin', JSON.stringify(panel.getState()));
    assert.equal(panel.browser.current?.selected.scope, 'published');
    assert.equal(panel.mode, 'browse');
    checks.push('own-published-review-uses-unified-native-changes-view');
    const fixture = JSON.parse(await readFile(path.join(project, 'build/review-test-fixture.json'), 'utf8')) as {
        alternateRequestId: number; filePath: string; expectedHead: string; virtualLine: number;
    };
    await panel.handleMessage({ type: 'openRemote', reviewId: fixture.alternateRequestId });
    const remote = panel.browser.current!;
    assert.equal(remote.review.links.submitter?.title, 'reviewer', JSON.stringify(panel.getState()));
    assert.equal(remote.username, 'admin');
    assert(remote.versions.every(version => version.scope === 'published'));
    assert.deepEqual(panel.form, ownForm);
    assert.deepEqual(panel.store.newForm(), defaults);
    await waitFor(() => api.sidebar.renderedState?.comparisonId === remote.id && api.sidebar.renderedState.mode === 'browse');
    checks.push('another-author-by-id-keeps-own-form-and-repository-defaults');
    const item = api.changes.getChildren().find(change => change.file.path === fixture.filePath)!;
    assert(item);
    await api.sidebar.openChange(item);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert(tab instanceof vscode.TabInputTextDiff);
    const modified = await vscode.workspace.openTextDocument(tab.modified);
    assert.equal(modified.getText(), fixture.expectedHead);
    assert.equal((await vscode.workspace.openTextDocument(tab.original)).getText(), 'A\nB\nC\nD\n');
    const source = new vscode.CancellationTokenSource();
    const ranges = await api.sidebar.comments.controller.commentingRangeProvider!.provideCommentingRanges(modified, source.token);
    assert(Array.isArray(ranges) && ranges.some(range => range.contains(new vscode.Position(1, 0)))); source.dispose();
    checks.push('remote-diff-loads-server-reconstruction-with-native-comment-ranges');
    const thread = api.sidebar.comments.controller.createCommentThread(tab.modified, new vscode.Range(1, 0, 1, 0), []);
    await vscode.commands.executeCommand('rbtflow.addComment', { thread, text: 'Native diff: D is the retained destination line.' });
    assert.equal(panel.feedback.comments.at(-1)?.firstLine, fixture.virtualLine, JSON.stringify(panel.getState()));
    assert.equal(panel.feedback.comments.at(-1)?.numLines, 1);
    checks.push('native-comment-command-maps-destination-line-two-to-virtual-row-four');
    panel = await api.sidebar.reload(labRoot);
    assert.deepEqual(panel.form, ownForm);
    assert.deepEqual(panel.store.settings(), { rbtPath, timeoutSeconds: 90 });
    assert.deepEqual(panel.store.newForm(), defaults);
    await panel.handleMessage({ type: 'openRemote', reviewId: fixture.alternateRequestId });
    assert.equal(panel.feedback.comments.length, 1, JSON.stringify(panel.getState()));
    assert.equal(panel.feedback.comments[0]!.firstLine, fixture.virtualLine);
    checks.push('actual-global-memento-restores-repository-settings-and-separate-review-draft');
    await api.sidebar.openChange(api.changes.getChildren().find(change => change.file.path === fixture.filePath)!);
    await panel.handleMessage({ type: 'feedbackEdit', body: 'Verified using the native VS Code diff.', shipIt: true });
    await capture('review');
    await panel.handleMessage({ type: 'saveFeedback', body: panel.feedback.body, shipIt: true });
    assert.equal(panel.feedbackSession.receipt?.published, false, JSON.stringify(panel.getState()));
    await waitFor(() => !!api.sidebar.renderedState?.canPublishFeedback);
    await assert.rejects(panel.removeInline(panel.feedback.comments[0]!.id), /服务器/);
    await panel.handleMessage({ type: 'publishFeedback', body: panel.feedback.body, shipIt: true });
    const feedbackReceipt = panel.feedbackSession.receipt!;
    assert.equal(feedbackReceipt?.published, true, JSON.stringify(panel.getState()));
    const reviewed = await panel.backend(feedbackReceipt.server).api<{ review: { public: boolean; ship_it: boolean } }>(`/review-requests/${fixture.alternateRequestId}/reviews/${feedbackReceipt.id}/`);
    assert(reviewed.review.public && reviewed.review.ship_it);
    checks.push('native-inline-comment-and-ship-it-saved-and-published-on-real-server');
    await panel.handleMessage({ type: 'load' });
    assert.deepEqual(panel.form, ownForm, JSON.stringify(panel.getState()));
    checks.push('another-author-review-cannot-be-loaded-as-own-submission');
    await panel.handleMessage({ type: 'new' });
    assert.equal(panel.form.reviewId, null); assert.equal(panel.form.summary, ''); assert.equal(panel.form.description, '');
    assert.deepEqual(panel.form.people, defaults.people); assert.deepEqual(panel.form.bugs, defaults.bugs);
    panel = await api.sidebar.reload(labRoot);
    assert.deepEqual(panel.form.people, defaults.people); assert.equal(panel.form.reviewId, null);
    await panel.handleMessage({ type: 'edit', form: { ...panel.form, summary: '合并分支后的更改审阅', description: '沿用仓库审批人和 Bug 号，预览本次提交。' } });
    checks.push('new-submission-inherits-repository-defaults-after-controller-recreation');
    await capture('submit');
    const receipt = submissionReceipt;
    await panel.handleMessage({ type: 'edit', form: { ...panel.form, server: 'http://different.invalid/' } });
    assert.equal(panel.form.repositoryId, null);
    assert.equal(panel.form.reviewId, null);
    assert.equal(panel.session.receipt, undefined);
    checks.push('server-change-clears-linked-review-identities');
    await mkdir(path.join(project, 'build/host'), { recursive: true });
    await writeFile(path.join(project, 'build/host/latest.json'), JSON.stringify({ status: 'PASS', vscode: vscode.version,
        checks, receipt, feedbackReceipt }, null, 2) + '\n');
    console.log(`PASS RBTFlow Extension Host: ${checks.join(', ')}`);
    panel.dispose();
}

async function capture(name: string): Promise<void> {
    if (!process.env.RBTFLOW_CDP_PORT) { return; }
    const dir = path.join(project, 'build/host');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'capture.json'), JSON.stringify({ name, time: Date.now() }));
    await waitFor(() => existsSync(path.join(dir, `${name}.png`)));
}
