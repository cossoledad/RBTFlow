import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { GitAdapter } from '../adapters/git';
import { RBToolsAdapter } from '../adapters/rbtools';
import { ReviewSession } from '../application/reviewSession';
import { inputKey, PendingWrite, ReviewFields, ReviewInput, serverUrl } from '../domain/model';
import { SnapshotFiles } from './snapshots';

export interface FormData extends ReviewInput, ReviewFields {}
export function initialForm(server = ''): FormData {
    return { server, repositoryId: null, targetRef: '', baseRef: '', mode: 'squash', reviewId: null,
        summary: '', description: '', testing: '', people: [], groups: [], bugs: [], branch: '', changeDescription: '' };
}
function parseForm(value: unknown): FormData {
    if (!value || typeof value !== 'object') { throw new Error('无效表单。'); }
    const raw = value as Record<string, unknown>;
    const strings = ['server', 'targetRef', 'baseRef', 'summary', 'description', 'testing', 'branch', 'changeDescription'] as const;
    for (const key of strings) { if (typeof raw[key] !== 'string' || (raw[key] as string).length > 200_000) { throw new Error('表单格式或长度无效。'); } }
    for (const key of ['people', 'groups', 'bugs']) {
        if (!Array.isArray(raw[key]) || raw[key].length > 200 || !(raw[key] as unknown[]).every(v => typeof v === 'string' && v.length < 1000)) { throw new Error('列表格式无效。'); }
    }
    for (const key of ['repositoryId', 'reviewId']) { if (raw[key] !== null && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 1)) { throw new Error('审核单/仓库 ID 无效。'); } }
    if (!['squash', 'history'].includes(String(raw.mode))) { throw new Error('审核模式无效。'); }
    return { ...raw, server: serverUrl(raw.server as string) } as unknown as FormData;
}

export class ReviewPanel implements vscode.Disposable {
    readonly panel: vscode.WebviewPanel;
    readonly session: ReviewSession;
    form: FormData;
    private refs: string[] = [];
    private repositories: { id: number; name: string }[] = [];
    private status = '选择目标主线，然后预览已提交的改动。';
    private error = '';
    private busy = false;
    private operation?: AbortController;
    private request = 0;
    private ready = false;
    renderedState?: { planId: string | null; files: number; canPost: boolean; canPublish: boolean };
    get webviewReady(): boolean { return this.ready; }
    private disposed = false;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly formKey: string;
    private readonly pendingKey: string;
    constructor(readonly root: string, private readonly context: vscode.ExtensionContext,
                private readonly git: GitAdapter, private readonly snapshots: SnapshotFiles,
                private readonly log: vscode.OutputChannel, private readonly roots: () => string[]) {
        this.formKey = `form:${root}`; this.pendingKey = `pending:${root}`;
        this.form = context.workspaceState.get<FormData>(this.formKey) ?? initialForm(vscode.workspace.getConfiguration('rbtflow', vscode.Uri.file(root)).get('serverUrl', ''));
        this.session = new ReviewSession(root, git, server => this.backend(server), {
            load: () => context.workspaceState.get<PendingWrite>(this.pendingKey),
            save: async value => { await context.workspaceState.update(this.pendingKey, value); },
        });
        this.panel = vscode.window.createWebviewPanel('rbtflow.review', `RBTFlow · ${path.basename(root)}`,
            vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
        this.subscriptions.push(this.panel.webview.onDidReceiveMessage(message => { void this.handleMessage(message); }),
            this.panel.onDidDispose(() => this.dispose()));
        void this.initialize().catch(error => this.showError(error));
    }
    backend(server = this.form.server): RBToolsAdapter {
        const config = vscode.workspace.getConfiguration('rbtflow', vscode.Uri.file(this.root));
        return new RBToolsAdapter(this.root, { executable: config.get('rbtPath', 'rbt'),
            storage: this.context.globalStorageUri.fsPath, server,
            timeoutMs: config.get('commandTimeoutSeconds', 120) * 1000,
            token: async url => this.context.secrets.get(`token:${url}`), log: message => this.log.appendLine(message) });
    }
    private async initialize(): Promise<void> {
        const [refs, html] = await Promise.all([
            this.git.refs(this.root), readFile(vscode.Uri.joinPath(this.context.extensionUri, 'media/review.html').fsPath, 'utf8'),
        ]);
        this.refs = refs;
        if (!this.form.targetRef) {
            this.form.targetRef = ['origin/main', 'origin/master', 'main', 'master'].find(ref => refs.includes(ref)) ?? refs[0] ?? '';
        }
        const nonce = randomBytes(24).toString('hex');
        const webview = this.panel.webview;
        this.panel.webview.html = html.replaceAll('{{nonce}}', nonce).replaceAll('{{cspSource}}', webview.cspSource)
            .replaceAll('{{script}}', webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media/review.js')).toString())
            .replaceAll('{{style}}', webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media/review.css')).toString());
    }
    getState(): object {
        const plan = this.session.plan;
        return { root: this.root, roots: this.roots(), form: this.form, refs: this.refs, repositories: this.repositories,
            busy: this.busy, status: this.status, error: this.error, pending: !!this.session.pending,
            pendingContext: this.session.pending ? `${this.session.pending.plan.server} · ${this.session.pending.id ? '审核 #' + this.session.pending.id : '新审核单'}` : '',
            plan: plan ? { id: plan.id, head: plan.git.head, target: plan.git.target, base: plan.git.base,
                branch: plan.git.branch, files: plan.git.files, warnings: plan.git.warnings,
                commits: plan.git.commits, merges: plan.git.merges, serverVersion: plan.serverVersion,
                rbtVersion: plan.rbtVersion, repository: plan.repository.name } : null,
            receipt: this.session.receipt ?? null };
    }
    private send(): void { if (this.ready && !this.disposed) { void this.panel.webview.postMessage({ type: 'state', state: this.getState() }); } }
    private showError(error: unknown): void {
        this.error = error instanceof Error ? error.message : String(error);
        this.log.appendLine(this.error); this.send();
    }
    invalidate(): void {
        // In-flight posting verifies Git immediately before writing; do not discard
        // the saved server receipt due to unrelated Git extension refresh events.
        if (this.busy) { return; }
        if (this.session.plan) {
            this.status = 'Git 状态可能已变化。提交前会重新检查；需要时请重新预览。'; this.send();
        }
    }
    async handleMessage(message: unknown): Promise<void> {
        if (!vscode.workspace.isTrusted) { this.showError(new Error('请先信任此工作区。')); return; }
        if (!message || typeof message !== 'object') { return; }
        const msg = message as Record<string, unknown>;
        const action = msg.type;
        if (action === 'ready') { this.ready = true; this.send(); return; }
        if (action === 'rendered') {
            if ((typeof msg.planId === 'string' || msg.planId === null) && Number.isSafeInteger(msg.files)) {
                this.renderedState = { planId: msg.planId as string | null, files: Number(msg.files), canPost: msg.canPost === true, canPublish: msg.canPublish === true };
            }
            return;
        }
        if (action === 'cancel') { this.operation?.abort(); return; }
        if (action === 'log') { this.log.show(); return; }
        if (action === 'openUrl') {
            const receipt = this.session.receipt;
            if (receipt) { await vscode.env.openExternal(vscode.Uri.parse(receipt.url)); }
            return;
        }
        if (action === 'selectRoot') {
            if (typeof msg.root === 'string' && this.roots().includes(msg.root)) { await vscode.commands.executeCommand('rbtflow.openReview', msg.root); }
            return;
        }
        if (this.busy) { return; }
        try {
            if (msg.form) {
                const form = parseForm(msg.form);
                if (form.server !== serverUrl(this.form.server)) {
                    form.repositoryId = null; form.reviewId = null; this.repositories = [];
                    this.session.receipt = undefined;
                    this.status = '服务器已改变，请重新选择服务器仓库和审核单。';
                }
                if (inputKey(form) !== inputKey(this.form)) { this.session.invalidate(); }
                this.form = form;
                await this.context.workspaceState.update(this.formKey, this.form);
            }
            if (action === 'edit') { this.send(); return; }
            if (action === 'diff') {
                if (!this.session.plan || !Number.isSafeInteger(msg.index)) { throw new Error('请先预览。'); }
                const index = Number(msg.index), plan = this.session.plan;
                const [left, right] = this.snapshots.uris(plan, index);
                await vscode.commands.executeCommand('vscode.diff', left, right, `${plan.git.files[index]!.path} · ${plan.git.base.slice(0, 8)} → ${plan.git.head.slice(0, 8)}`);
                return;
            }
            if (action === 'patch') {
                if (!this.session.patch) { throw new Error('请先预览。'); }
                const document = await vscode.workspace.openTextDocument({ language: 'diff', content: this.session.patch.toString('utf8') });
                await vscode.window.showTextDocument(document); return;
            }
            if (action === 'token') {
                const url = await vscode.commands.executeCommand<string | undefined>('rbtflow.setToken', this.form.server);
                if (url) {
                    if (url !== this.form.server) { this.form.repositoryId = null; this.form.reviewId = null; this.repositories = []; this.session.receipt = undefined; }
                    this.form.server = url; this.session.invalidate(); await this.context.workspaceState.update(this.formKey, this.form); this.send();
                }
                return;
            }
            if (action === 'clearPending') {
                if (await vscode.window.showWarningMessage('只有核对服务器草稿、确认不会重复提交后，才清除此状态。', { modal: true }, '已核对，清除状态') === '已核对，清除状态') {
                    await this.context.workspaceState.update(this.pendingKey, undefined); this.session.invalidate(); this.send();
                }
                return;
            }
            const allowed = ['connect', 'preview', 'post', 'publish', 'load', 'people', 'groups', 'reconcile'];
            if (!allowed.includes(String(action))) { return; }
            this.busy = true; this.error = ''; this.status = '正在处理…'; this.operation = new AbortController();
            const request = ++this.request, signal = this.operation.signal;
            this.send();
            try {
                if (action === 'connect') {
                    const connection = await this.session.connect(this.form.server, signal);
                    this.repositories = connection.repositories;
                    this.form.server = connection.server;
                    this.status = `已连接 Review Board ${connection.version}，用户 ${connection.username}。请选择服务器仓库。`;
                } else if (action === 'preview') {
                    const plan = await this.session.preview(this.form, signal);
                    this.form = { ...this.form, server: plan.server, repositoryId: plan.repository.id };
                    if (!this.form.summary) { this.form.summary = plan.previous ? (plan.previous.draft ?? plan.previous.review).summary : plan.git.summary; }
                    if (!this.form.branch) { this.form.branch = this.form.targetRef.replace(/^refs\/remotes\//, '').replace(/^[^/]+\//, ''); }
                    this.status = `已预览 ${plan.git.files.length} 个文件，${plan.git.commits} 个提交。保存将创建未发布草稿。`;
                } else if (action === 'post') {
                    if (typeof msg.planId !== 'string') { throw new Error('预览已过期。'); }
                    const receipt = await this.session.post(msg.planId, this.form, this.form, signal);
                    this.form.reviewId = receipt.id;
                    this.status = `审核 #${receipt.id} 草稿已保存，diff 第 ${receipt.diffRevision} 版。主 patch、字段与文件集合已核对；尚未发布。`;
                } else if (action === 'publish') {
                    if (typeof msg.planId !== 'string') { throw new Error('请先保存当前草稿。'); }
                    const receipt = await this.session.publish(msg.planId, this.form, this.form, signal);
                    this.status = `审核 #${receipt.id} 已发布，diff 第 ${receipt.diffRevision} 版。`;
                } else if (action === 'load') {
                    if (!this.form.reviewId) { throw new Error('请输入审核单 ID。'); }
                    const snapshot = await this.backend().snapshot(this.form.reviewId, signal), fields = snapshot.draft ?? snapshot.review;
                    this.session.invalidate();
                    this.form = { ...this.form, mode: snapshot.review.created_with_history ? 'history' : 'squash',
                        summary: fields.summary, description: fields.description, testing: fields.testing_done,
                        branch: fields.branch, people: fields.target_people.map(p => p.title!), groups: fields.target_groups.map(g => g.title!), bugs: fields.bugs_closed };
                    this.status = `已载入审核 #${this.form.reviewId}。请重新预览后更新。`;
                } else if (action === 'people' || action === 'groups') {
                    const query = await vscode.window.showInputBox({ prompt: action === 'people' ? '搜索审批人' : '搜索审批组', placeHolder: '输入名称或留空显示全部' });
                    if (query !== undefined) {
                        const key = action === 'people' ? 'users' : 'groups';
                        const items = await this.backend().list<{ username?: string; name?: string; fullname?: string; display_name?: string }>(`/${key}/`, key, { q: query }, signal);
                        const selected = await vscode.window.showQuickPick(items.map(item => ({ label: item.username ?? item.name!,
                            description: item.fullname ?? item.display_name, picked: (action === 'people' ? this.form.people : this.form.groups).includes(item.username ?? item.name!) })), { canPickMany: true });
                        if (selected) { this.form[action] = selected.map(item => item.label); }
                    }
                    this.status = '审批信息已更新。';
                } else if (action === 'reconcile') {
                    const pending = this.session.pending;
                    const receipt = await this.session.reconcile(signal);
                    if (receipt) {
                        if (pending) {
                            this.form = { ...this.form, ...pending.fields, ...pending.plan.input,
                                server: pending.plan.server, reviewId: receipt.id };
                            this.repositories = [];
                        }
                        this.form.reviewId = receipt.id;
                        this.status = `已核对审核 #${receipt.id}，${receipt.published ? '已发布' : '草稿已保存'}。已恢复对应的服务器和表单；继续编辑前请重新预览。`;
                    }
                }
                if (request === this.request) { await this.context.workspaceState.update(this.formKey, this.form); }
            } finally { this.busy = false; this.operation = undefined; this.send(); }
        } catch (error) { this.showError(error); }
    }
    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true; this.operation?.abort(); this.session.invalidate();
        for (const item of this.subscriptions) { item.dispose(); }
        this.panel.dispose();
    }
}
