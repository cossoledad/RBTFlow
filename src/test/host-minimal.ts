import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { RBTFlowAPI } from '../extension';
import type { DiscussionReview } from '../domain/discussion';
import { project } from './helpers';

export async function run(): Promise<void> {
    const root = process.env.RBTFLOW_HOST_ROOT!;
    const api = await vscode.extensions.getExtension<RBTFlowAPI>('ganjinbo.rbtflow')!.activate();
    const controller = (await api.open(root))!;
    assert.equal(controller.pluginMode, 'minimal');
    assert.equal(api.sidebar.inbox.state, undefined);
    await vscode.workspace.getConfiguration('rbtflow', vscode.Uri.file(root)).update('notifications.enabled', true, vscode.ConfigurationTarget.Global);
    const fixture = JSON.parse(await readFile(path.join(project, 'build/review-test-fixture.json'), 'utf8')) as { alternateRequestId: number };
    assert(await controller.openRemote(fixture.alternateRequestId));
    const comparison = controller.browser.current!;
    const backend = controller.backend(comparison.server);
    const list = () => backend.list<DiscussionReview>(`/review-requests/${comparison.requestId}/reviews/`, 'reviews');
    const before = new Set((await list()).filter(review => review.public).map(review => review.id));
    const body = 'Minimal mode Ship It acceptance';
    await controller.setFeedback(body, true);
    const row = api.sidebar.review.getChildren().find(item => item.key === 'publishShipIts')!;
    assert(row?.action);
    const publication = api.sidebar.run(row.action);
    await new Promise(resolve => setTimeout(resolve, 800));
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await publication;
    assert.equal(controller.lastError, undefined);
    assert.equal(controller.pending, false);
    const created = (await list()).filter(review => review.public && !before.has(review.id));
    assert.equal(created.length, 2);
    assert(created.every(review => review.ship_it && review.links.user?.title === comparison.username));
    assert.deepEqual(created.map(review => review.body_top).sort(), ['', body]);
    await Promise.all([api.sidebar.inbox.refresh(), controller.pollRemote()]);
    assert.equal(api.sidebar.inbox.state, undefined);
    assert.equal(api.sidebar.inbox.busy, false);
    const reopened = await api.sidebar.reload(root);
    assert.equal(reopened.browser.current, undefined);
    assert.equal(reopened.lastRequest?.id, comparison.requestId);
    await api.sidebar.run(api.sidebar.review.getChildren().find(item => item.key === 'lastRequest')!.action!);
    const selected = reopened.comparison();
    assert(selected?.kind === 'remote');
    assert.equal(selected.requestId, comparison.requestId);
    await reopened.setFeedback('Preserve unsent feedback', false);
    assert(await reopened.preview());
    assert(await reopened.createDraft());
    const draft = reopened.lastDraft!;
    const draftBackend = reopened.backend(draft.server);
    const original = await draftBackend.snapshot(draft.id);
    await vscode.commands.executeCommand('rbtflow.clearReview');
    assert.equal(reopened.comparison(), undefined);
    assert.equal(api.changes.getFiles().length, 0);
    assert.deepEqual(api.sidebar.review.getChildren(), []);
    assert.equal((await draftBackend.snapshot(draft.id)).fingerprint, original.fingerprint);
    assert(await reopened.openRemote(fixture.alternateRequestId));
    assert.equal(reopened.feedback.body, 'Preserve unsent feedback');
    await vscode.commands.executeCommand('rbtflow.clearReview');
    const clean = await api.sidebar.reload(root);
    assert.equal(clean.comparison(), undefined);
    assert.equal(clean.lastRequest, undefined);
    assert.equal(clean.lastDraft?.id, draft.id);
    const draftRow = api.sidebar.submit.getChildren().find(item => item.key === 'openDraft')!;
    await api.sidebar.run(draftRow.action!);
    assert.equal(clean.browser.current?.requestId, draft.id);
    assert.equal(clean.browser.current?.selected.scope, 'draft');
    assert(api.changes.getFiles().length > 0);
    assert.equal(clean.canPublishRequest, true);

    const checks = ['minimal-by-default-even-with-notifications-enabled', 'manual-request-and-two-native-ship-it-reviews',
        'inbox-and-background-probe-inactive', 'last-request-is-restored-only-on-demand',
        'clear-empties-review-and-changes-without-mutating-draft', 'clear-retains-unsent-feedback',
        'submit-reopens-draft-after-clearing-another-request-and-reloading'];
    await writeFile(path.join(project, 'build/host/latest.json'), JSON.stringify({ status: 'PASS', vscode: vscode.version, checks }, null, 2) + '\n');
}
