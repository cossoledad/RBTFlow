import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GitAdapter } from '../adapters/git';
import { ReviewController } from './reviewController';
import { SnapshotFiles } from './snapshots';
import { ChangeItem, ChangesTree } from './changesTree';
import { ReviewComments } from './reviewComments';

export class ReviewSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
    private view?: vscode.WebviewView;
    private readonly controllers = new Map<string, ReviewController>();
    private readonly initializing = new Map<string, Promise<ReviewController>>();
    current?: ReviewController;
    webviewReady = false;
    renderedState?: { root: string; comparisonId: string | null; canPost: boolean; canPublish: boolean; canPublishFeedback: boolean; mode: string };
    private selection = 0;
    private comparisonId = '';
    private feedbackFingerprint = '';
    readonly comments: ReviewComments;
    constructor(private readonly context: vscode.ExtensionContext, private readonly git: GitAdapter,
                private readonly snapshots: SnapshotFiles, readonly changes: ChangesTree,
                private readonly log: vscode.OutputChannel, private readonly roots: () => string[]) {
        this.comments = new ReviewComments(snapshots, () => this.current);
    }
    async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
        this.view = view; this.webviewReady = false;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
        const nonce = randomBytes(24).toString('hex');
        const html = await readFile(vscode.Uri.joinPath(this.context.extensionUri, 'media/review.html').fsPath, 'utf8');
        const messages = view.webview.onDidReceiveMessage(message => { void this.handle(message).catch(error => { this.log.appendLine(String(error)); void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }); });
        const disposed = view.onDidDispose(() => { messages.dispose(); disposed.dispose(); this.view = undefined; this.webviewReady = false; });
        view.webview.html = html.replaceAll('{{nonce}}', nonce).replaceAll('{{cspSource}}', view.webview.cspSource)
            .replaceAll('{{script}}', view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media/review.js')).toString())
            .replaceAll('{{style}}', view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media/review.css')).toString());
        if (!this.current) { await this.selectDefault(false); } else { this.render(); }
    }
    async selectDefault(focus = true): Promise<ReviewController | undefined> {
        const remembered = this.context.globalState.get<string>('lastRepository');
        const root = remembered && this.roots().includes(remembered) ? remembered : this.roots()[0];
        return root ? this.open(root, focus) : undefined;
    }
    async open(root: string, focus = true): Promise<ReviewController> {
        if (!this.roots().includes(root)) { throw new Error('请选择当前工作区中的 Git 仓库。'); }
        if (this.current?.busy && this.current.root !== root) { throw new Error('请先完成或取消当前操作，再切换仓库。'); }
        const version = ++this.selection;
        let controller = this.controllers.get(root);
        if (!controller) {
            let pending = this.initializing.get(root);
            if (!pending) {
                const fresh = new ReviewController(root, this.context, this.git, this.log);
                pending = fresh.initialize().then(() => {
                    this.controllers.set(root, fresh);
                    this.context.subscriptions.push(fresh.onDidChange(() => { if (this.current === fresh) { this.render(); } }));
                    return fresh;
                }).catch(error => { fresh.dispose(); throw error; }).finally(() => { this.initializing.delete(root); });
                this.initializing.set(root, pending);
            }
            controller = await pending;
        }
        if (version === this.selection) {
            if (this.current !== controller) { this.comments.clear(); }
            this.current = controller; await this.context.globalState.update('lastRepository', root); this.render();
        }
        if (focus) { await vscode.commands.executeCommand('rbtflow.review.focus'); this.view?.show(true); }
        return controller;
    }
    invalidate(root: string): void { this.controllers.get(root)?.invalidate(); }
    async repositoriesChanged(): Promise<void> { if (this.view && !this.current && this.roots().length) { await this.selectDefault(false); } }
    async reload(root: string): Promise<ReviewController> {
        if (this.controllers.get(root)?.busy) { throw new Error('请等待当前操作完成。'); }
        this.controllers.get(root)?.dispose(); this.controllers.delete(root);
        if (this.current?.root === root) { this.current = undefined; }
        return this.open(root);
    }
    private render(): void {
        const controller = this.current, comparison = controller?.comparison();
        const nextId = comparison?.kind === 'local' ? comparison.plan.id : comparison?.id ?? '';
        if (nextId !== this.comparisonId) { this.comments.clear(); this.comparisonId = nextId; }
        const fingerprint = controller?.feedbackSession.receipt?.fingerprint ?? '';
        if (!controller?.busy && fingerprint !== this.feedbackFingerprint) {
            this.feedbackFingerprint = fingerprint;
            void this.comments.refresh().catch(error => this.log.appendLine(`读取评论：${String(error)}`));
        }
        if (controller && comparison) {
            const id = comparison.kind === 'local' ? comparison.plan.id : comparison.id;
            const label = comparison.kind === 'local' ? '本地预览' : `#${comparison.requestId} · ${comparison.selected.scope === 'draft' ? '草稿 ' : ''}v${comparison.selected.revision}`;
            this.changes.update(controller.root, id, label, comparison.kind === 'local' ? comparison.plan.git.files : comparison.files);
        } else { this.changes.update(controller?.root ?? '', '', '', []); }
        if (this.webviewReady) { void this.view?.webview.postMessage({ type: 'state', state: controller?.getState() ?? null }); }
    }
    private async handle(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') { return; }
        const msg = message as Record<string, unknown>;
        if (msg.type === 'ready') { this.webviewReady = true; this.render(); return; }
        if (msg.type === 'rendered') {
            this.renderedState = { root: String(msg.root), comparisonId: typeof msg.comparisonId === 'string' ? msg.comparisonId : null,
                canPost: msg.canPost === true, canPublish: msg.canPublish === true, canPublishFeedback: msg.canPublishFeedback === true, mode: String(msg.mode) }; return;
        }
        if (msg.type === 'selectRoot') { await vscode.commands.executeCommand('rbtflow.chooseRepository'); return; }
        if (msg.type === 'log') { this.log.show(); return; }
        if (msg.type === 'patch') { await this.showPatch(); return; }
        const controller = this.controllers.get(typeof msg.root === 'string' ? msg.root : this.current?.root ?? '');
        if (!controller) { return; }
        if (msg.type === 'openUrl') {
            const comparison = controller.comparison();
            const url = comparison?.kind === 'remote' ? `${comparison.server}r/${comparison.requestId}/` : controller.session.receipt?.url;
            if (url) { await vscode.env.openExternal(vscode.Uri.parse(url)); } return;
        }
        if (msg.type === 'more') { await controller.store.set('moreOpen', msg.open === true); return; }
        await controller.handleMessage(msg);
    }
    async openChange(item: ChangeItem): Promise<void> {
        const controller = this.current, comparison = controller?.comparison();
        const id = comparison?.kind === 'local' ? comparison.plan.id : comparison?.id;
        if (!controller || !comparison || item.root !== controller.root || item.comparisonId !== id) { throw new Error('对比已切换，请从当前更改列表重新打开文件。'); }
        let uris: [vscode.Uri, vscode.Uri], title: string;
        if (comparison.kind === 'local') {
            uris = this.snapshots.uris(comparison.plan, item.index); title = `${item.file.path} · 本地预览`;
        } else {
            uris = this.snapshots.remoteUris(comparison, controller.backend(comparison.server), item.index);
            title = `${item.file.path} · #${comparison.requestId} v${comparison.selected.revision}${comparison.selected.scope === 'draft' ? ' 草稿' : ''}`;
        }
        await vscode.commands.executeCommand('vscode.diff', uris[0], uris[1], title);
        if (comparison.kind === 'remote') { await this.comments.show(uris); }
    }
    async showPatch(): Promise<void> {
        const controller = this.current, comparison = controller?.comparison(); if (!controller || !comparison) { return; }
        const bytes = comparison.kind === 'local' ? await controller.backend(comparison.plan.server).diff(comparison.plan.git, comparison.plan.input, comparison.plan.repository)
            : await controller.backend(comparison.server).comparisonData(comparison, 0, 'patch');
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'diff', content: bytes.toString('utf8') }));
    }
    dispose(): void { for (const controller of this.controllers.values()) { controller.dispose(); } this.comments.dispose(); }
}
