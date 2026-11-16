import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitAdapter } from '../adapters/git';
import { RBToolsAdapter } from '../adapters/rbtools';
import { ReviewSession } from '../application/reviewSession';
import { FormData, RepositoryStore } from '../application/repositoryStore';
import { ReviewBrowser } from '../application/reviewBrowser';
import { FeedbackSession } from '../application/feedbackSession';
import { digest, inputKey, PendingWrite, ReviewPlan, ReviewResource, serverUrl } from '../domain/model';
import { DiffVersion, draftRestriction, InlineDraft, RemoteComparison, ReviewFeedback, ReviewWrite } from '../domain/comparison';

interface FeedbackCache { feedback: ReviewFeedback; base: string; }
export type Comparison = { kind: 'local'; plan: ReviewPlan } | RemoteComparison;

function parseForm(value: unknown): FormData {
    if (!value || typeof value !== 'object') { throw new Error('无效表单。'); }
    const raw = value as Record<string, unknown>;
    for (const key of ['server', 'targetRef', 'baseRef', 'summary', 'description', 'testing', 'branch', 'changeDescription']) {
        if (typeof raw[key] !== 'string' || (raw[key] as string).length > 200_000 || (raw[key] as string).includes('\0')) { throw new Error('表单格式或长度无效。'); }
    }
    for (const key of ['people', 'groups', 'bugs']) {
        if (!Array.isArray(raw[key]) || raw[key].length > 200 || !(raw[key] as unknown[]).every(item => typeof item === 'string' && item.length < 1000)) { throw new Error('列表格式无效。'); }
    }
    for (const key of ['repositoryId', 'reviewId']) { if (raw[key] !== null && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 1)) { throw new Error('审核单/仓库 ID 无效。'); } }
    if (!['squash', 'history'].includes(String(raw.mode))) { throw new Error('审核模式无效。'); }
    return { ...raw, server: serverUrl(raw.server as string) } as unknown as FormData;
}
const emptyFeedback = (): ReviewFeedback => ({ body: '', shipIt: false, comments: [] });

/** Repository-owned state, independent of the sidebar's lifetime and current viewer. */
export class ReviewController implements vscode.Disposable {
    readonly session: ReviewSession;
    readonly browser: ReviewBrowser;
    readonly feedbackSession: FeedbackSession;
    readonly store: RepositoryStore;
    form: FormData;
    feedback = emptyFeedback();
    mode: 'submit' | 'browse' = 'submit';
    browseId: number | null = null;
    busy = false;
    private refs: string[] = [];
    private localSnapshot?: ReviewPlan;
    private status = '';
    private error = '';
    private feedbackConflict = false;
    private operation?: AbortController;
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    constructor(readonly root: string, private readonly context: vscode.ExtensionContext,
                private readonly git: GitAdapter, private readonly log: vscode.OutputChannel) {
        this.store = new RepositoryStore(root, context.globalState, context.workspaceState);
        this.form = this.store.form(this.config().get('serverUrl', ''));
        this.session = new ReviewSession(root, git, server => this.backend(server), {
            load: () => this.store.get<PendingWrite>('submissionPending'), save: value => this.store.set('submissionPending', value),
        });
        this.browser = new ReviewBrowser(server => this.backend(server));
        this.feedbackSession = new FeedbackSession(server => this.backend(server), {
            load: () => this.store.get<ReviewWrite>('feedbackPending'), save: value => this.store.set('feedbackPending', value),
        });
    }
    private config(): vscode.WorkspaceConfiguration { return vscode.workspace.getConfiguration('rbtflow', vscode.Uri.file(this.root)); }
    async initialize(): Promise<void> {
        await this.store.initialize();
        const cached = this.store.get<FormData>('ownForm');
        this.form = this.store.form(this.config().get('serverUrl', ''));
        this.refs = await this.git.refs(this.root);
        if (!cached) {
            try {
                const defaults = await this.backend().repositoryDefaults();
                const list = (value?: string | string[]) => typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
                if (!this.form.server && defaults.server) { this.form.server = serverUrl(defaults.server); }
                if (defaults.targetRef && this.refs.includes(defaults.targetRef)) { this.form.targetRef = defaults.targetRef; }
                this.form.people = list(defaults.people); this.form.groups = list(defaults.groups);
                if (defaults.branch) { this.form.branch = defaults.branch; }
            } catch (error) { this.log.appendLine(`读取仓库默认配置：${error instanceof Error ? error.message : String(error)}`); }
        }
        if (!this.form.targetRef) { this.form.targetRef = ['origin/main', 'origin/master', 'main', 'master'].find(ref => this.refs.includes(ref)) ?? this.refs[0] ?? ''; }
        this.browseId = this.store.get<number>('lastBrowseId') ?? this.form.reviewId;
        this.mode = this.store.get<'submit' | 'browse'>('lastMode') ?? 'submit';
        await this.store.saveOwn(this.form, !cached);
    }
    backend(server = this.form.server): RBToolsAdapter {
        const settings = this.store.settings(), config = this.config();
        return new RBToolsAdapter(this.root, { executable: settings.rbtPath || config.get('rbtPath', 'rbt'),
            storage: this.context.globalStorageUri.fsPath, server,
            timeoutMs: (settings.timeoutSeconds ?? config.get('commandTimeoutSeconds', 120)) * 1000,
            token: async url => this.context.secrets.get(`token:${url}`), log: message => this.log.appendLine(message) });
    }
    comparison(): Comparison | undefined {
        if (this.mode === 'browse') { return this.browser.current; }
        const plan = this.session.plan ?? this.localSnapshot;
        return plan ? { kind: 'local', plan } : undefined;
    }
    getState(): object {
        const plan = this.session.plan ?? this.localSnapshot, remote = this.browser.current;
        const pending = this.session.pending, feedbackPending = this.feedbackSession.store.load();
        return { root: this.root, rootName: path.basename(this.root), mode: this.mode, form: this.form, refs: this.refs,
            busy: this.busy, status: this.status, error: this.error, moreOpen: this.store.get<boolean>('moreOpen') ?? false,
            pending: !!pending, pendingContext: pending ? `${pending.plan.server} · ${pending.id ? '#' + pending.id : '新审核单'}` : '',
            feedbackPending: !!feedbackPending, feedbackPendingContext: feedbackPending ? `${feedbackPending.comparison.server} · #${feedbackPending.comparison.requestId}` : '',
            canPost: !!this.session.plan && !pending, canPublish: !!this.session.plan && !!this.session.receipt && !this.session.receipt.published && !pending,
            plan: plan ? { id: plan.id, head: plan.git.head, base: plan.git.base, target: plan.git.target, branch: plan.git.branch,
                files: plan.git.files.length, commits: plan.git.commits, merges: plan.git.merges, warnings: plan.git.warnings } : null,
            receipt: this.session.receipt ?? null, browseId: this.browseId,
            remote: remote ? { id: remote.id, requestId: remote.requestId, title: remote.details.summary,
                author: remote.review.links.submitter?.title, username: remote.username, repository: remote.repositoryName,
                selected: remote.selected, versions: remote.versions, files: remote.files.length, status: remote.review.status,
                canEdit: remote.review.links.submitter?.title === remote.username && remote.review.status === 'pending',
                canReview: remote.selected.scope === 'published' && remote.review.status === 'pending',
                description: remote.details.description, testing: remote.details.testing_done } : null,
            feedback: this.feedback, feedbackConflict: this.feedbackConflict,
            feedbackRestriction: remote ? draftRestriction(remote) : '',
            savedCommentCount: remote?.reviewerComments.length ?? 0, draftBottom: remote?.reviewerDraft?.body_bottom ?? '',
            localCommentCount: this.feedback.comments.filter(item => !remote?.reviewerComments.some(saved => saved.extra_data.rbtflow_comment_id === item.id)).length,
            feedbackReceipt: this.feedbackSession.receipt ?? null,
            canPublishFeedback: !!remote && !draftRestriction(remote) && this.feedbackSession.receipt?.diffId === remote.selected.id && !this.feedbackSession.receipt.published && !feedbackPending && !this.feedbackConflict,
        };
    }
    emit(): void { this.changed.fire(); }
    invalidate(): void { if (!this.busy && this.session.plan) { this.status = 'Git 状态可能已变化；保存前会重新检查。'; this.emit(); } }
    cancel(): void { this.operation?.abort(); }
    private async own(form: FormData, defaults = true): Promise<void> {
        if (form.server !== serverUrl(this.form.server)) {
            form.repositoryId = null; form.reviewId = null; this.session.receipt = undefined;
            this.browser.clear(); this.feedbackSession.receipt = undefined;
        }
        if (inputKey(form) !== inputKey(this.form)) { this.session.invalidate(); this.localSnapshot = undefined; }
        this.form = form; await this.store.saveOwn(form, defaults);
    }
    private feedbackKey(comparison: RemoteComparison): string { return `feedback:${comparison.server}:${comparison.username}:${comparison.requestId}:${comparison.selected.id}`; }
    private async cacheFeedback(): Promise<void> {
        const comparison = this.browser.current;
        if (comparison) {
            const key = this.feedbackKey(comparison), previous = this.store.get<FeedbackCache>(key);
            await this.store.set(key, { feedback: this.feedback, base: this.feedbackConflict && previous ? previous.base : digest(JSON.stringify(comparison.reviewerDraft)) } satisfies FeedbackCache);
        }
    }
    async addInline(comparisonId: string, comment: InlineDraft): Promise<void> {
        if (this.busy || this.browser.current?.id !== comparisonId || this.mode !== 'browse') { throw new Error('请返回对应的审核版本再添加评论。'); }
        if (!comment.text.trim() || comment.text.length > 200_000 || comment.text.includes('\0')) { throw new Error('评论不能为空或超过长度限制。'); }
        this.feedback.comments.push(comment); this.feedbackSession.receipt = undefined;
        await this.cacheFeedback(); this.status = '行内评论已加入本地草稿。'; this.emit();
    }
    async removeInline(id: string): Promise<void> {
        if (this.busy) { throw new Error('请等待当前操作完成。'); }
        if (this.browser.current?.reviewerComments.some(comment => comment.extra_data.rbtflow_comment_id === id)) { throw new Error('该评论已保存至服务器，请在审核网页中编辑或删除。'); }
        this.feedback.comments = this.feedback.comments.filter(comment => comment.id !== id);
        this.feedbackSession.receipt = undefined; await this.cacheFeedback(); this.emit();
    }
    private async openRemote(id: number, selection?: Pick<DiffVersion, 'scope' | 'revision'>,
                             server = this.form.server, signal?: AbortSignal, verified?: ReviewFeedback): Promise<void> {
        const comparison = await this.browser.open(server, id, selection, signal);
        this.mode = 'browse'; this.browseId = id; this.feedbackSession.receipt = undefined;
        const cache = this.store.get<FeedbackCache>(this.feedbackKey(comparison));
        this.feedbackConflict = !!cache && cache.base !== digest(JSON.stringify(comparison.reviewerDraft)) && !verified;
        this.feedback = verified ?? cache?.feedback ?? { ...emptyFeedback(), body: comparison.reviewerDraft?.body_top ?? '', shipIt: comparison.reviewerDraft?.ship_it ?? false };
        await this.store.set('lastBrowseId', id);
        await this.store.set('lastMode', 'browse');
        this.status = '';
    }
    private async loadOwn(id: number, signal?: AbortSignal): Promise<void> {
        const backend = this.backend(), connection = await backend.connect(signal);
        const resource = (await backend.api<{ review_request: ReviewResource }>(`/review-requests/${id}/`, {}, signal)).review_request;
        if (resource.links.submitter?.title !== connection.username) { throw new Error('他人的审核单请在“审阅”中打开，不能作为自己的提交编辑。'); }
        const repoId = Number(new URL(resource.links.repository!.href).pathname.match(/\/repositories\/(\d+)\/$/)?.[1]);
        const normalize = (value: string) => value.replace(/^git@([^:]+):/, 'ssh://git@$1/').replace(/\.git\/?$/, '').replace(/\/$/, '');
        const remotes = (await this.git.remotes(this.root, signal)).map(normalize);
        const repo = connection.repositories.find(item => item.id === repoId);
        if (!repo || (this.form.repositoryId !== repoId && ![repo.path, repo.mirror_path].some(value => value && remotes.includes(normalize(value))))) {
            throw new Error('当前 Git 仓库与审核单不匹配，请选择对应仓库后再编辑。');
        }
        const snapshot = await backend.snapshot(id, signal), fields = snapshot.draft ?? snapshot.review;
        this.session.invalidate(); this.localSnapshot = undefined;
        this.form = { ...this.form, server: connection.server, repositoryId: repoId, reviewId: id,
            mode: resource.created_with_history ? 'history' : 'squash', summary: fields.summary, description: fields.description,
            testing: fields.testing_done, branch: fields.branch, bugs: fields.bugs_closed,
            people: fields.target_people.map(person => person.title!), groups: fields.target_groups.map(group => group.title!) };
        await this.store.saveOwn(this.form, false); this.mode = 'submit'; await this.store.set('lastMode', 'submit'); this.status = `编辑 #${id}，请重新预览。`;
    }
    async settings(setting?: string): Promise<void> {
        if (this.busy) { throw new Error('请等待当前操作完成。'); }
        const items = [
            { label: '目标主线', value: 'targetRef', description: this.form.targetRef },
            { label: '服务器地址', value: 'server', description: this.form.server || '从 RBTools 配置读取' },
            { label: '服务器 Git 仓库', value: 'repositoryId', description: this.form.repositoryId ? '#' + this.form.repositoryId : '按 remote 匹配' },
            { label: '显式 BASE', value: 'baseRef', description: this.form.baseRef || '自动共同基线' },
            { label: '审核模式', value: 'mode', description: this.form.mode === 'history' ? '逐提交历史' : '汇总 diff' },
            { label: 'RBTools 路径', value: 'rbtPath', description: this.backend().options.executable },
            { label: '命令超时（秒）', value: 'timeout', description: String((this.backend().options.timeoutMs ?? 120_000) / 1000) },
            { label: 'API Token', value: 'token', description: '由 SecretStorage 保存' },
        ];
        const key = setting ?? (await vscode.window.showQuickPick(items, { placeHolder: '仓库设置 · 自动按当前仓库保存' }))?.value;
        if (!key) { return; }
        const form = structuredClone(this.form);
        if (key === 'token') {
            const url = await vscode.commands.executeCommand<string>('rbtflow.setToken', form.server);
            if (url) { form.server = url; await this.own(form); }
        } else if (key === 'targetRef') {
            const value = await vscode.window.showQuickPick(this.refs, { placeHolder: '选择目标主线 / tracking branch' });
            if (value) { form.targetRef = value; await this.own(form); }
        } else if (key === 'repositoryId') {
            const connection = await this.backend().connect();
            const repo = await vscode.window.showQuickPick(connection.repositories.map(item => ({ label: item.name, description: `#${item.id}`, value: item.id })), { placeHolder: '选择服务器 Git 仓库' });
            if (repo) { form.repositoryId = repo.value; await this.own(form); }
        } else if (key === 'mode') {
            const item = await vscode.window.showQuickPick([{ label: '汇总 diff', value: 'squash' as const }, { label: '逐提交历史', value: 'history' as const }]);
            if (item) { form.mode = item.value; await this.own(form); }
        } else if (key === 'server' || key === 'baseRef') {
            const value = await vscode.window.showInputBox({ prompt: key === 'server' ? 'Review Board URL；留空沿用项目 RBTools 配置' : '显式 BASE；留空使用共同基线', value: form[key] });
            if (value !== undefined) { form[key] = key === 'server' ? serverUrl(value) : value; await this.own(form); }
        } else if (key === 'rbtPath' || key === 'timeout') {
            const settings = this.store.settings();
            const value = await vscode.window.showInputBox({ prompt: key === 'rbtPath' ? 'RBTools 可执行文件；留空沿用 VS Code 设置' : '命令超时，5–1800 秒；留空沿用 VS Code 设置',
                value: key === 'rbtPath' ? settings.rbtPath ?? '' : settings.timeoutSeconds?.toString() ?? '' });
            if (value !== undefined) {
                if (key === 'timeout' && value && (!Number.isFinite(Number(value)) || Number(value) < 5 || Number(value) > 1800)) { throw new Error('超时需为 5–1800 秒。'); }
                if (key === 'rbtPath') { settings.rbtPath = value || undefined; } else { settings.timeoutSeconds = value ? Number(value) : undefined; }
                await this.store.set('settings', settings); this.session.invalidate(); this.localSnapshot = undefined;
            }
        }
        this.emit();
    }
    async handleMessage(message: unknown): Promise<void> {
        if (!vscode.workspace.isTrusted) { return; }
        if (!message || typeof message !== 'object') { return; }
        const msg = message as Record<string, unknown>, action = String(msg.type);
        if (action === 'cancel') { this.cancel(); return; }
        if (this.busy) { return; }
        try {
            this.error = '';
            if (msg.form && ['edit', 'preview', 'post', 'publish', 'new', 'load'].includes(action)) {
                const form = parseForm(msg.form);
                await this.own(form, JSON.stringify(form) !== JSON.stringify(this.form));
            }
            if (action === 'edit') { this.emit(); return; }
            if (action === 'feedbackEdit') {
                if (typeof msg.body !== 'string' || msg.body.length > 200_000 || typeof msg.shipIt !== 'boolean') { throw new Error('无效审阅意见。'); }
                if (this.feedback.body === msg.body && this.feedback.shipIt === msg.shipIt) { return; }
                this.feedback.body = msg.body; this.feedback.shipIt = msg.shipIt;
                this.feedbackSession.receipt = undefined; await this.cacheFeedback(); this.emit(); return;
            }
            if (action === 'settings') { await this.settings(typeof msg.setting === 'string' ? msg.setting : undefined); return; }
            if (action === 'mode') { this.mode = msg.mode === 'browse' ? 'browse' : 'submit'; await this.store.set('lastMode', this.mode); this.emit(); return; }
            if (action === 'new') {
                this.session.invalidate(); this.session.receipt = undefined; this.localSnapshot = undefined;
                this.form = this.store.newForm(); this.mode = 'submit'; await this.store.set('lastMode', 'submit'); await this.store.saveOwn(this.form, false); this.status = '新建审核，已沿用仓库默认设置。'; this.emit(); return;
            }
            if (!['preview', 'post', 'publish', 'load', 'people', 'groups', 'openRemote', 'myReviews', 'version', 'saveFeedback', 'publishFeedback', 'reloadFeedback', 'reconcile', 'reconcileFeedback', 'clearPending'].includes(action)) { return; }
            this.busy = true; this.error = ''; this.status = '处理中…'; this.operation = new AbortController(); this.emit();
            const signal = this.operation.signal;
            try {
                if (action === 'preview') {
                    const plan = await this.session.preview(this.form, signal);
                    this.localSnapshot = plan; this.mode = 'submit';
                    await this.store.set('lastMode', 'submit');
                    this.form = { ...this.form, server: plan.server, repositoryId: plan.repository.id };
                    if (!this.form.summary) { this.form.summary = plan.previous ? (plan.previous.draft ?? plan.previous.review).summary : plan.git.summary; }
                    if (!this.form.branch) { this.form.branch = this.form.targetRef.replace(/^refs\/remotes\//, '').replace(/^[^/]+\//, ''); }
                    await this.store.saveOwn(this.form); this.status = `${plan.git.files.length} 个更改 · ${plan.git.merges} 个 merge`;
                } else if (action === 'post') {
                    if (typeof msg.planId !== 'string') { throw new Error('请重新预览。'); }
                    const receipt = await this.session.post(msg.planId, this.form, this.form, signal);
                    this.form.reviewId = receipt.id; await this.store.saveOwn(this.form); this.status = `#${receipt.id} 草稿已保存 · v${receipt.diffRevision}`;
                } else if (action === 'publish') {
                    if (typeof msg.planId !== 'string') { throw new Error('请先保存草稿。'); }
                    const receipt = await this.session.publish(msg.planId, this.form, this.form, signal); this.status = `#${receipt.id} 已发布`;
                } else if (action === 'load') {
                    const id = this.mode === 'browse' ? this.browser.current?.requestId : this.form.reviewId;
                    if (!id) { throw new Error('请先打开审核单。'); } await this.loadOwn(id, signal);
                } else if (action === 'people' || action === 'groups') {
                    const query = await vscode.window.showInputBox({ prompt: action === 'people' ? '搜索审批人' : '搜索审批组' });
                    if (query !== undefined) {
                        const key = action === 'people' ? 'users' : 'groups';
                        const items = await this.backend().list<{ username?: string; name?: string; fullname?: string; display_name?: string }>(`/${key}/`, key, { q: query }, signal);
                        const selected = await vscode.window.showQuickPick(items.map(item => ({ label: item.username ?? item.name!, description: item.fullname ?? item.display_name,
                            picked: this.form[action].includes(item.username ?? item.name!) })), { canPickMany: true });
                        if (selected) { this.form[action] = selected.map(item => item.label); await this.store.saveOwn(this.form); }
                    }
                    this.status = '';
                } else if (action === 'myReviews') {
                    const context = await this.backend().context(signal), backend = this.backend(context.server), user = await backend.username(signal);
                    const reviews = await backend.list<ReviewResource>('/review-requests/', 'review_requests', { 'from-user': user, status: 'all', ...(this.form.repositoryId ? { repository: String(this.form.repositoryId) } : {}) }, signal);
                    const chosen = await vscode.window.showQuickPick(reviews.sort((a, b) => b.id - a.id).map(review => ({ label: `#${review.id} ${review.summary || '未发布草稿'}`, description: review.status, id: review.id })), { placeHolder: '我的审核' });
                    if (chosen) { await this.openRemote(chosen.id, undefined, context.server, signal); }
                } else if (action === 'openRemote' || action === 'version') {
                    const id = action === 'version' ? this.browser.current?.requestId : Number(msg.reviewId);
                    if (!id) { throw new Error('请输入审核单 ID。'); }
                    this.browseId = id;
                    const selection = action === 'version' ? { scope: msg.scope === 'draft' ? 'draft' as const : 'published' as const, revision: Number(msg.revision) } : undefined;
                    await this.openRemote(id, selection, this.browser.current?.server && action === 'version' ? this.browser.current.server : this.form.server, signal);
                } else if (action === 'saveFeedback' || action === 'publishFeedback') {
                    if (typeof msg.body === 'string' && msg.body.length <= 200_000 && typeof msg.shipIt === 'boolean') {
                        this.feedback.body = msg.body; this.feedback.shipIt = msg.shipIt;
                    }
                    const comparison = this.browser.current;
                    if (!comparison || this.feedbackConflict) { throw new Error('请载入并核对服务器审阅草稿。'); }
                    const receipt = action === 'saveFeedback' ? await this.feedbackSession.save(comparison, this.feedback, signal) : await this.feedbackSession.publish(comparison, this.feedback, signal);
                    if (receipt.published) { await this.store.set(this.feedbackKey(comparison), undefined); this.feedback = emptyFeedback(); }
                    else { await this.cacheFeedback(); }
                    this.status = `审阅${receipt.published ? '已发布' : '草稿已保存'} · #${receipt.requestId}`;
                } else if (action === 'reloadFeedback') {
                    const old = this.browser.current;
                    if (old) { await this.store.set('feedbackBackup', { comparison: old, feedback: this.feedback }); await this.store.set(this.feedbackKey(old), undefined); await this.openRemote(old.requestId, old.selected, old.server, signal); }
                } else if (action === 'reconcile') {
                    const pending = this.session.pending, receipt = await this.session.reconcile(signal);
                    if (receipt) {
                        if (pending) { this.form = { ...this.form, ...pending.fields, ...pending.plan.input, server: pending.plan.server, reviewId: receipt.id }; }
                        await this.store.saveOwn(this.form, false); this.mode = 'submit'; this.status = `已核对 #${receipt.id} · ${receipt.published ? '已发布' : '草稿'}`;
                    }
                } else if (action === 'reconcileFeedback') {
                    const pending = this.feedbackSession.store.load(), receipt = await this.feedbackSession.reconcile(signal);
                    if (pending && receipt) {
                        await this.openRemote(pending.comparison.requestId, pending.comparison.selected, pending.comparison.server, signal,
                            receipt.published ? emptyFeedback() : pending.feedback);
                        this.feedbackSession.receipt = receipt; await this.cacheFeedback(); this.status = '审阅结果已核对。';
                    }
                } else if (action === 'clearPending') {
                    const choice = await vscode.window.showWarningMessage('请先核对服务器结果，避免重复提交。清除哪项待确认状态？', { modal: true }, '提交', '审阅');
                    if (choice === '审阅') {
                        await this.feedbackSession.store.save(undefined);
                    } else if (choice === '提交' && this.session.pending) { await this.session.pendingStore.save(undefined); }
                }
            } finally { this.busy = false; this.operation = undefined; this.emit(); }
        } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.log.appendLine(this.error); this.emit(); }
    }
    dispose(): void { this.cancel(); this.session.invalidate(); this.browser.clear(); this.changed.dispose(); }
}
