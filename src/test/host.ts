import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { RBTFlowAPI } from '../extension';
import { fields, labRoot, project } from './helpers';

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
    assert(api.roots().includes(labRoot));
    checks.push('activate-and-discover-repository');
    const panel = await api.open(labRoot);
    assert(panel);
    await waitFor(() => panel.webviewReady);
    checks.push('webview-script-loaded-under-csp');
    await panel.handleMessage({ type: 'preview', form: { ...panel.form, ...fields, reviewId: null, mode: 'squash' } });
    assert(panel.session.plan, JSON.stringify(panel.getState()));
    const plan = panel.session.plan;
    await waitFor(() => panel.renderedState?.planId === plan.id && panel.renderedState.files === plan.git.files.length && panel.renderedState.canPost);
    assert.equal(panel.renderedState!.canPublish, false);
    checks.push('real-preview-rendered-files-and-submit-state');
    const index = plan.git.files.findIndex(file => file.status === 'M');
    await panel.handleMessage({ type: 'diff', index, form: panel.form });
    const documents = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'rbtflow');
    assert(documents.some(document => document.getText() === 'base\n'));
    assert(documents.some(document => document.getText() === 'feature greeting\n'));
    assert(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputTextDiff));
    checks.push('native-diff-opens-exact-base-head-snapshots');
    panel.panel.reveal();
    await panel.handleMessage({ type: 'post', planId: plan.id, form: panel.form });
    assert(panel.session.receipt, JSON.stringify(panel.getState()));
    assert.equal(panel.session.receipt.published, false);
    await waitFor(() => !!panel.renderedState?.canPublish);
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
    checks.push('separate-publish-action-verifies-server-result');
    const receipt = panel.session.receipt;
    await panel.handleMessage({ type: 'edit', form: { ...panel.form, server: 'http://different.invalid/' } });
    assert.equal(panel.form.repositoryId, null);
    assert.equal(panel.form.reviewId, null);
    assert.equal(panel.session.receipt, undefined);
    checks.push('server-change-clears-linked-review-identities');
    await mkdir(path.join(project, 'build/host'), { recursive: true });
    await writeFile(path.join(project, 'build/host/latest.json'), JSON.stringify({ status: 'PASS', vscode: vscode.version,
        checks, receipt }, null, 2) + '\n');
    console.log(`PASS RBTFlow Extension Host: ${checks.join(', ')}`);
    panel.dispose();
}
