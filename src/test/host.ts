import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { RBTFlowAPI } from '../extension';
import { labRoot, project, rbtPath } from './helpers';
import { ChangeNode } from '../views/changesTree';

async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!check()) { if (Date.now() > deadline) { throw new Error('Native UI timed out'); } await new Promise(resolve => setTimeout(resolve, 50)); }
}
async function capture(name: string): Promise<void> {
    if (!process.env.RBTFLOW_CDP_PORT) { return; }
    const dir = path.join(project, 'build/host'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'capture.json'), JSON.stringify({ name, time: Date.now() }));
    await waitFor(() => existsSync(path.join(dir, `${name}.png`)));
}
function leafCount(nodes: ChangeNode[]): number { return nodes.reduce((count, node) => count + (node.kind === 'folder' ? leafCount(node.children) : 1), 0); }

export async function run(): Promise<void> {
    const checks: string[] = [], root = process.env.RBTFLOW_HOST_ROOT || labRoot;
    const packageManifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')) as { publisher: string; name: string };
    const extension = vscode.extensions.getExtension<RBTFlowAPI>(`${packageManifest.publisher}.${packageManifest.name}`); assert(extension);
    const api = await extension.activate(); await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    assert(api.roots().includes(root));
    const manifest = extension.packageJSON as { contributes: { views: { rbtflow: { id: string; type?: string }[] } } };
    assert.deepEqual(manifest.contributes.views.rbtflow.map(view => view.id), ['rbtflow.submit', 'rbtflow.review', 'rbtflow.changes']);
    assert(manifest.contributes.views.rbtflow.every(view => view.type !== 'webview'));
    let controller = await api.open(root); assert(controller);
    checks.push('three-native-tree-views-without-webviews');
    controller.form.people = []; controller.form.groups = []; controller.form.bugs = ['NATIVE-1'];
    await controller.store.saveOwn(controller.form);
    assert(await controller.preview(), String(controller.lastError));
    const plan = controller.session.plan!;
    assert(controller.form.summary.trim()); assert(controller.form.description.trim());
    const generated = { summary: controller.form.summary, description: controller.form.description };
    assert(api.sidebar.submit.getChildren().some(item => item.key === 'message' && item.description === generated.summary));
    checks.push('preview-defaults-title-and-description-from-rbt-commit-parser');
    assert.equal(api.changes.getFiles().length, plan.git.files.length);
    const nodes = api.changes.getChildren(); assert(nodes.some(node => node.kind === 'folder')); assert.equal(leafCount(nodes), plan.git.files.length);
    await vscode.commands.executeCommand('rbtflow.showList'); assert(api.changes.getChildren().every(node => node.kind === 'file'));
    await vscode.commands.executeCommand('rbtflow.showTree'); assert.equal(leafCount(api.changes.getChildren()), plan.git.files.length);
    checks.push('native-tree-and-list-layouts-cover-real-nested-git-files');
    await api.sidebar.showPatch();
    const raw = vscode.window.activeTextEditor!.document, original = raw.getText();
    assert.equal(raw.uri.scheme, 'rbtflow'); assert.equal(raw.isUntitled, false); assert.equal(original, controller.previewPatch!.toString('utf8'));
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(raw.uri, Buffer.from('modified'))));
    await vscode.commands.executeCommand('type', { text: 'modified' }); assert.equal(raw.getText(), original);
    checks.push('raw-patch-is-a-readonly-snapshot-and-rejects-native-typing');
    const changed = api.changes.getFiles().find(item => item.file.path === 'greeting.txt')!; assert(changed);
    await vscode.commands.executeCommand('rbtflow.openChange', changed);
    const docs = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'rbtflow');
    assert(docs.some(document => document.getText() === 'base\n')); assert(docs.some(document => document.getText() === 'feature greeting\n'));
    checks.push('native-file-diff-opens-frozen-base-and-head');
    await vscode.commands.executeCommand('rbtflow.createDraft');
    const remote = controller.browser.current!; assert(remote, String(controller.lastError));
    assert.equal(remote.selected.scope, 'draft'); assert.equal(remote.details.summary, generated.summary); assert.equal(remote.details.description, generated.description);
    assert.equal(controller.form.reviewId, null); assert.equal(controller.form.summary, ''); assert.equal(controller.session.plan, undefined);
    assert.equal(controller.comparison()?.kind, 'remote');
    assert(api.sidebar.review.getChildren().some(item => item.key === 'publishRequest'));
    assert(api.sidebar.submit.getChildren().every(item => !['publishRequest', 'testing', 'changeDescription'].includes(item.key)));
    checks.push('created-draft-hands-off-to-review-and-clears-submission-identity');
    const id = remote.requestId;
    await controller.editDetails('review', 'description');
    const descriptionEditor = vscode.window.activeTextEditor!;
    await descriptionEditor.edit(edit => edit.replace(new vscode.Range(descriptionEditor.document.positionAt(0), descriptionEditor.document.positionAt(descriptionEditor.document.getText().length)), 'Native description'));
    await descriptionEditor.document.save();
    try { await waitFor(() => !controller!.busy && controller!.browser.current?.details.description === 'Native description'); }
    catch (error) {
        await writeFile(path.join(project, 'build/host/snapshot-drift.json'), JSON.stringify({ expected: controller.browser.current?.requestSnapshot,
            observed: await controller.backend(remote.server).snapshot(id), error: String(controller.lastError) }, null, 2));
        throw error;
    }
    await descriptionEditor.edit(edit => edit.insert(descriptionEditor.document.positionAt(descriptionEditor.document.getText().length), '\n\nSecond save'));
    await descriptionEditor.document.save();
    await waitFor(() => !controller!.busy && controller!.browser.current?.details.description === 'Native description\n\nSecond save');
    checks.push('native-description-editor-can-save-repeatedly-to-the-same-server-draft');
    await controller.store.set('settings', { rbtPath, timeoutSeconds: 90 });
    controller.form.people = ['reviewer']; await controller.store.saveOwn(controller.form); controller.emit();
    const publishing = controller.publishRequest();
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(controller.pending, false, 'No write uncertainty while selecting missing reviewers');
    await capture('reviewers');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    assert(await publishing, String(controller.lastError));
    assert(controller.browser.current?.review.public); assert.equal(controller.requestSession.store.load(), undefined);
    assert(controller.browser.current.details.target_people.some(person => person.title === 'reviewer'));
    checks.push('publish-with-no-reviewer-opens-native-quick-pick-and-publishes-without-api-225');
    const published = { id, server: controller.browser.current.server };
    const ownForm = structuredClone(controller.form), defaults = controller.store.newForm();
    const fixture = JSON.parse(await readFile(path.join(project, 'build/review-test-fixture.json'), 'utf8')) as { alternateRequestId: number; filePath: string; expectedHead: string; virtualLine: number };
    assert(await controller.openRemote(fixture.alternateRequestId), String(controller.lastError));
    assert.equal(controller.browser.current?.review.links.submitter?.title, 'reviewer');
    assert.deepEqual(controller.form, ownForm); assert.deepEqual(controller.store.newForm(), defaults);
    checks.push('another-author-by-id-keeps-submission-and-repository-defaults');
    await api.sidebar.openChange(api.changes.getFiles().find(item => item.file.path === fixture.filePath)!);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input; assert(tab instanceof vscode.TabInputTextDiff);
    assert.equal((await vscode.workspace.openTextDocument(tab.modified)).getText(), fixture.expectedHead);
    assert.equal((await vscode.workspace.openTextDocument(tab.original)).getText(), 'A\nB\nC\nD\n');
    const thread = api.sidebar.comments.controller.createCommentThread(tab.modified, new vscode.Range(1, 0, 1, 0), []);
    await vscode.commands.executeCommand('rbtflow.addComment', { thread, text: `Native review from request #${id}` });
    assert.equal(controller.feedback.comments.at(-1)?.firstLine, fixture.virtualLine);
    checks.push('native-comment-maps-real-destination-line-to-review-board-virtual-row');
    controller = await api.sidebar.reload(root);
    assert.deepEqual(controller.form, ownForm); assert.deepEqual(controller.store.settings(), { rbtPath, timeoutSeconds: 90 });
    assert.equal(controller.browser.current?.requestId, fixture.alternateRequestId); assert.equal(controller.feedback.comments.length, 1);
    checks.push('global-storage-restores-review-selection-local-comments-and-repository-settings');
    await controller.editFeedback();
    const editor = vscode.window.activeTextEditor!; assert(editor.document.uri.fsPath.includes('/inputs/'));
    assert(await editor.edit(edit => { edit.insert(new vscode.Position(0, 0), 'Reviewed with native VS Code controls.'); }));
    assert(await editor.document.save()); await waitFor(() => controller!.feedback.body === 'Reviewed with native VS Code controls.');
    const ship = api.sidebar.review.getChildren().find(item => item.key === 'shipIt')!;
    assert.equal(ship.checkboxState, vscode.TreeItemCheckboxState.Unchecked);
    await controller.setFeedback(controller.feedback.body, true);
    assert.equal(api.sidebar.review.getChildren().find(item => item.key === 'shipIt')!.checkboxState, vscode.TreeItemCheckboxState.Checked);
    checks.push('multiline-review-input-uses-native-editor-and-ship-it-uses-native-checkbox');
    await api.sidebar.openChange(api.changes.getFiles().find(item => item.file.path === fixture.filePath)!);
    assert(await controller.saveFeedback(), String(controller.lastError));
    await capture('review');
    assert(await controller.saveFeedback(true), String(controller.lastError));
    const feedbackReceipt = controller.feedbackSession.receipt!; assert(feedbackReceipt.published);
    checks.push('native-review-and-inline-comments-save-and-publish-on-real-server');
    await controller.newSubmission(); assert.deepEqual(controller.form.people, ['reviewer']); assert.equal(controller.form.reviewId, null);
    assert(await controller.preview());
    assert.equal(controller.browser.current, undefined); assert.equal(controller.canReview, false);
    await api.sidebar.showPatch(); await vscode.commands.executeCommand('workbench.action.closePanel');
    await capture('submit');
    checks.push('new-submission-retains-defaults-and-remains-independent-of-server-review');
    await mkdir(path.join(project, 'build/host'), { recursive: true });
    await writeFile(path.join(project, 'build/host/latest.json'), JSON.stringify({ status: 'PASS', vscode: vscode.version, checks, published, feedbackReceipt }, null, 2) + '\n');
    console.log(`PASS RBTFlow Extension Host: ${checks.join(', ')}`);
}
