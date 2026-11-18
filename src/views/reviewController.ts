import * as vscode from 'vscode';
import { GitAdapter } from '../adapters/git';
import { ApiError, RBToolsAdapter } from '../adapters/rbtools';
import { ProcessError } from '../adapters/process';
import { ReviewSession } from '../application/reviewSession';
import { FormData, PluginMode, RepositoryStore } from '../application/repositoryStore';
import { ComparisonVersionError, ReviewBrowser } from '../application/reviewBrowser';
import { FeedbackSession } from '../application/feedbackSession';
import { RequestMetadata, requestFields, RequestSession, RequestWrite } from '../application/requestSession';
import { CommitConflict, diffModes, digest, PendingWrite, PublishValidationError, ReviewPlan, ReviewResource, serverUrl } from '../domain/model';
import { sameSnapshot } from '../domain/snapshot';
import { probeToken } from '../domain/activity';
import { DiffVersion, InlineDraft, RemoteComparison, ReviewFeedback, ReviewWrite } from '../domain/comparison';
import { NativeInputs, pickRecipients, Recipients } from './nativeInputs';
import { DiscussionSession } from '../application/discussionSession';
import { CommitConflictError, ReviewSafetyError } from '../domain/submission';

interface FeedbackCache { feedback: ReviewFeedback; base: string; version?: 2; }
interface LastRequest { id: number; server: string; }
interface LastDraft extends LastRequest { username: string; }
interface MessageOverride { head: string; summary?: string; description?: string; }
export type Comparison = { kind: 'local'; plan: ReviewPlan } | RemoteComparison;
const emptyFeedback = (): ReviewFeedback => ({ body: '', shipIt: false, comments: [] });
const ids = (value: string): string[] => [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];

/** Repository state and actions. All input and progress belong to native VS Code controls. */
export class ReviewController implements vscode.Disposable {
    readonly session: ReviewSession;
    readonly browser: ReviewBrowser;
    readonly feedbackSession: FeedbackSession;
    readonly requestSession: RequestSession;
    readonly discussion: DiscussionSession;
    readonly store: RepositoryStore;
    form: FormData;
    feedback = emptyFeedback();
    feedbackConflict = false;
    branch = '';
    busy = false;
    lastError?: unknown;
    previewPatch?: Buffer;
    connectionVersion = 0;
    remoteOutdated = false;
    private polling?: Promise<void>;
    private readonly refreshed = new vscode.EventEmitter<void>();
    readonly onDidRefreshRemote = this.refreshed.event;
    private readonly viewed = new vscode.EventEmitter<RemoteComparison>();
    readonly onDidViewRequest = this.viewed.event;
    private refs: string[] = [];
    private localPreview?: ReviewPlan;
    private selected: 'local' | 'remote' = 'remote';
    private operation?: AbortController;
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    constructor(readonly root: string, private readonly context: vscode.ExtensionContext,
                private readonly git: GitAdapter, private readonly log: vscode.LogOutputChannel, private readonly inputs: NativeInputs) {
        this.store = new RepositoryStore(root, context.globalState, context.workspaceState);
        this.form = this.store.form(this.config().get('serverUrl', ''));
        this.session = new ReviewSession(root, git, server => this.backend(server), {
            load: () => this.store.get<PendingWrite>('submissionPending'), save: value => this.store.set('submissionPending', value),
            loadConflict: () => this.store.get('commitConflict'), saveConflict: value => this.store.set('commitConflict', value),
        });
        this.browser = new ReviewBrowser(server => this.backend(server));
        this.discussion = new DiscussionSession(server => this.backend(server));
        this.feedbackSession = new FeedbackSession(server => this.backend(server), {
            load: () => this.store.get<ReviewWrite>('feedbackPending'), save: value => this.store.set('feedbackPending', value),
        });
        this.requestSession = new RequestSession(server => this.backend(server), {
            load: () => this.store.get<RequestWrite>('requestPending'), save: value => this.store.set('requestPending', value),
        });
    }
    private config(): vscode.WorkspaceConfiguration { return vscode.workspace.getConfiguration('rbtflow', vscode.Uri.file(this.root)); }
    get pluginMode(): PluginMode { return this.store.settings().mode ?? this.config().get<PluginMode>('mode', 'minimal'); }
    get lastRequest(): LastRequest | undefined { return this.store.get<LastRequest>('lastRequest'); }
    get lastDraft(): LastDraft | undefined { return this.store.get<LastDraft>('lastDraft'); }
    async initialize(): Promise<void> {
        await this.store.initialize();
        const cached = this.store.get<FormData>('ownForm'); this.form = this.store.form(this.config().get('serverUrl', ''));
        [this.refs, this.branch] = await Promise.all([this.git.refs(this.root), this.git.branch(this.root)]);
        if (!cached || !this.form.server) {
            try {
                const defaults = await this.backend().repositoryDefaults();
                const list = (value?: string | string[]) => typeof value === 'string' ? ids(value) : value ?? [];
                if (!this.form.server && defaults.server) { this.form.server = serverUrl(defaults.server); }
                if (!cached) {
                    this.form.people = list(defaults.people); this.form.groups = list(defaults.groups);
                    if (defaults.targetRef && this.refs.includes(defaults.targetRef)) { this.form.targetRef = defaults.targetRef; }
                }
            } catch (error) { this.log.warn('Could not read repository defaults', error); }
        }
        if (!this.form.targetRef) { this.form.targetRef = ['origin/main', 'origin/master', 'main', 'master'].find(ref => this.refs.includes(ref)) ?? this.refs[0] ?? ''; }
        if (!this.store.get('nativeUI')) {
            await this.store.set('legacySubmission', cached);
            const previousId = this.form.reviewId ?? this.store.get<number>('lastBrowseId');
            if (previousId && !this.store.get('lastRequest')) { await this.store.set('lastRequest', { id: previousId, server: this.form.server }); }
            if (this.form.reviewId || !this.form.description.trim()) { this.form.summary = ''; this.form.description = ''; }
            else if (this.form.summary) { await this.store.set('messageOverride', { head: await this.git.resolve(this.root, 'HEAD'), summary: this.form.summary, description: this.form.description }); }
            this.form.reviewId = null; this.form.testing = ''; this.form.changeDescription = '';
            await this.store.set('nativeUI', true);
        }
        await this.store.saveOwn(this.form, !cached);
        if (this.pluginMode === 'minimal') { return; }
        if (this.session.pending?.kind === 'post') {
            try { await this.session.inspectConflict(); }
            catch (error) { this.log.warn('Could not inspect the uploaded draft', error); }
        }
        // Upgrade recovery is read-only. A verified unpublished draft is safe to
        // return to Review after a definitive 225 rejection in an older version.
        if (this.session.pending?.kind === 'publish') {
            try {
                const server = this.session.pending.plan.server, receipt = await this.session.reconcile();
                if (receipt) { await this.store.set('lastRequest', { id: receipt.id, server }); this.log.info(`Recovered request #${receipt.id}: ${receipt.published ? 'published' : 'draft'}`); }
            } catch (error) { this.log.warn('Previous publication needs a server check', error); }
        }
        const last = this.store.get<LastRequest>('lastRequest');
        if (last) { try { await this.loadRemote(last.id, undefined, last.server); } catch (error) { this.log.warn(`Could not restore request #${last.id}`, error); } }
    }
    backend(server = this.form.server): RBToolsAdapter {
        const settings = this.store.settings(), config = this.config();
        return new RBToolsAdapter(this.root, { executable: settings.rbtPath || config.get('rbtPath', 'rbt'), storage: this.context.globalStorageUri.fsPath, server,
            timeoutMs: (settings.timeoutSeconds ?? config.get('commandTimeoutSeconds', 120)) * 1000,
            token: async url => this.context.secrets.get(`token:${url}`), log: message => this.log.info(message) });
    }
    comparison(): Comparison | undefined { return this.selected === 'local' ? this.localPreview && { kind: 'local', plan: this.localPreview } : this.browser.current; }
    get mode(): 'submit' | 'browse' { return this.selected === 'local' ? 'submit' : 'browse'; }
    get pending(): boolean { return !!this.session.pending || !!this.requestSession.store.load() || !!this.feedbackSession.store.load(); }
    get canCreate(): boolean { return !!this.session.plan && this.session.plan.input.reviewId === null && !this.session.pending && !this.session.conflict; }
    get retainedConflict(): CommitConflict | undefined {
        const remote = this.browser.current;
        if (!remote?.requestSnapshot?.draft || remote.selected.scope !== 'draft') { return; }
        return this.store.get<{ record: PendingWrite }[]>('submissionArchives')?.find(({ record }) => record.id === remote.requestId
            && record.plan.server === remote.server && record.plan.username === remote.username
            && record.plan.id === remote.details.extra_data.rbtflow_plan_id && remote.details.commit_id !== record.plan.git.head)?.record.commitConflict;
    }
    get retainedPatchMismatch(): boolean {
        const remote = this.browser.current;
        if (!remote?.requestSnapshot?.draft) { return false; }
        return this.store.get<{ record: PendingWrite }[]>('submissionArchives')?.some(({ record }) =>
            record.patchMismatch === true && record.id === remote.requestId && record.plan.server === remote.server
            && record.plan.username === remote.username && record.plan.id === remote.details.extra_data.rbtflow_plan_id) ?? false;
    }
    get canEditRequest(): boolean { const remote = this.browser.current; return !this.remoteOutdated && !this.retainedConflict && !!remote?.requestSnapshot && remote.review.status === 'pending'; }
    get canPublishRequest(): boolean { return this.selected === 'remote' && this.canEditRequest && !this.retainedPatchMismatch && !!this.browser.current?.requestSnapshot?.draft && !this.pending; }
    get canDiscardRequest(): boolean {
        const remote = this.browser.current;
        return this.selected === 'remote' && !this.remoteOutdated && !this.pending && !!remote?.requestSnapshot
            && remote.review.status === 'pending' && remote.selected.revision === Math.max(...remote.versions.map(version => version.revision));
    }
    get canReview(): boolean { const remote = this.browser.current; return !this.remoteOutdated && this.selected === 'remote' && !!remote && remote.selected.scope === 'published' && remote.review.public && remote.review.status === 'pending'
        && remote.selected.revision === Math.max(...remote.versions.filter(version => version.scope === 'published').map(version => version.revision)); }
    emit(): void { this.changed.fire(); }
    async invalidate(): Promise<void> {
        const plan = this.session.plan;
        try {
            if (plan && !this.busy && await this.git.fingerprint(this.root, plan.input) !== plan.git.fingerprint && this.session.plan?.id === plan.id && !this.busy) { this.session.invalidate(); }
            this.branch = await this.git.branch(this.root);
        } catch (error) { this.log.debug('Git refresh failed', error); }
        this.emit();
    }
    cancel(): void { this.operation?.abort(); }
    private async idle(): Promise<void> {
        if (!this.busy) { return; }
        await new Promise<void>(resolve => { const subscription = this.onDidChange(() => { if (!this.busy) { subscription.dispose(); resolve(); } }); });
    }
    private async perform(title: string, section: 'submit' | 'review', work: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
        if (this.busy) { return false; }
        this.busy = true; this.lastError = undefined; this.operation = new AbortController(); this.emit();
        try {
            await vscode.window.withProgress({ location: { viewId: `rbtflow.${section}` }, title }, () => work(this.operation!.signal));
            this.log.info(title); return true;
        } catch (error) {
            this.lastError = error; this.log.error(title, error);
            if (error instanceof CommitConflictError) {
                const choice = error.conflict.requests.length === 1 ? `Open #${error.conflict.requests[0]!.id}` : undefined;
                void vscode.window.showWarningMessage(error.message, ...(choice ? [choice, 'Show output'] : ['Show output'])).then(value => {
                    if (value === 'Show output') { this.log.show(); }
                    else if (choice && value === choice && this.session.conflict?.head === error.conflict.head && this.session.conflict.server === error.conflict.server
                        && this.session.pending?.id === error.draftId) { void this.continueFromConflict(error.conflict.requests[0]!.id); }
                });
                return false;
            }
            if (error instanceof ProcessError) {
                if (error.stdout.length) { this.log.error(error.stdout.toString('utf8')); }
                if (error.stderr.length) { this.log.error(error.stderr.toString('utf8')); }
                if (error.reason === 'cancelled') { return false; }
            }
            const brief = error instanceof PublishValidationError || error instanceof ReviewSafetyError ? error.message : error instanceof ApiError && error.brief ? error.brief : 'Operation failed. See RBTFlow output.';
            void vscode.window.showErrorMessage(brief, 'Show output').then(choice => { if (choice) { this.log.show(); } });
            return false;
        } finally { this.busy = false; this.operation = undefined; this.emit(); }
    }
    async preview(): Promise<boolean> {
        return this.perform('Preview changes', 'submit', async signal => {
            const plan = await this.session.preview({ ...this.form, reviewId: null }, signal);
            const raw = await this.git.commitMessage(this.root, plan.git.base, plan.git.head, signal);
            const guessed = await this.backend(plan.server).guessMessage(raw, signal), override = this.store.get<MessageOverride>('messageOverride');
            const custom = override?.head === plan.git.head ? override : undefined;
            this.form = { ...this.form, server: plan.server, repositoryId: plan.repository.id, reviewId: null, mode: plan.input.mode,
                summary: custom?.summary ?? guessed.summary ?? plan.git.summary,
                description: custom?.description ?? guessed.description ?? guessed.summary ?? plan.git.summary,
                testing: guessed.testing_done ?? '', changeDescription: '' };
            if (!this.form.description.trim()) { this.form.description = this.form.summary; }
            this.form.branch = plan.input.targetRef;
            this.branch = plan.git.branch; this.localPreview = plan; this.selected = 'local';
            this.previewPatch = this.session.patch && Buffer.from(this.session.patch);
            this.browser.clear(); this.discussion.clear(); this.feedback = emptyFeedback(); this.feedbackConflict = false; this.feedbackSession.receipt = undefined;
            await this.store.saveOwn(this.form);
            for (const warning of plan.git.warnings) { this.log.info(warning); }
            this.log.info(`${plan.git.files.length} files, ${plan.git.commits} commits, ${plan.git.merges} merges; ${plan.git.base} → ${plan.git.head}`);
        });
    }
    async createDraft(): Promise<boolean> {
        return this.perform('Create draft', 'submit', async signal => {
            const plan = this.session.plan;
            if (this.session.conflict) { throw new CommitConflictError(this.session.conflict, this.session.pending?.id); }
            if (this.session.pending) { throw new ReviewSafetyError('Check the previous submission before creating a draft.'); }
            if (!plan || !this.canCreate) { throw new Error('Preview changes first.'); }
            const receipt = await this.session.post(plan.id, this.form, this.form, signal);
            const server = plan.server; await this.store.set('lastRequest', { id: receipt.id, server });
            await this.store.set('lastDraft', { id: receipt.id, server, username: plan.username } satisfies LastDraft);
            await this.resetSubmission(); this.selected = 'remote'; this.browser.clear();
            await this.loadRemote(receipt.id, undefined, server, signal);
            this.log.info(`Draft #${receipt.id}: ${receipt.url}`); vscode.window.setStatusBarMessage(`Draft #${receipt.id} created`, 3500);
        });
    }
    private async resetSubmission(): Promise<void> {
        this.session.invalidate(); this.localPreview = undefined; this.previewPatch = undefined; this.form = this.store.newForm();
        await this.store.set('messageOverride', undefined); await this.store.saveOwn(this.form, false);
    }
    async newSubmission(): Promise<void> { if (!this.busy) { await this.resetSubmission(); this.selected = 'remote'; this.emit(); } }
    async clearReview(): Promise<void> {
        if (!this.busy) { await this.perform('Clear review', 'review', () => this.clearSelection()); }
    }
    private async clearSelection(): Promise<void> {
        this.browser.clear();
        this.discussion.clear();
        this.session.invalidate();
        this.localPreview = undefined;
        this.previewPatch = undefined;
        this.selected = 'remote';
        this.remoteOutdated = false;
        this.feedback = emptyFeedback();
        this.feedbackConflict = false;
        this.feedbackSession.receipt = undefined;
        await this.store.set('lastRequest', undefined);
    }
    private async forgetDraft(request: LastDraft): Promise<void> {
        const last = this.lastDraft;
        if (last?.id === request.id && last.server === request.server && last.username === request.username) {
            await this.store.set('lastDraft', undefined);
        }
    }
    async openDraft(): Promise<boolean> {
        const draft = this.lastDraft;
        if (!draft) { return false; }
        return this.perform(`Open draft #${draft.id}`, 'review', async signal => {
            const backend = this.backend(draft.server);
            if (await backend.username(signal) !== draft.username) { throw new ReviewSafetyError('Sign in as the draft author.'); }
            let snapshot;
            try { snapshot = await backend.snapshot(draft.id, signal); }
            catch (error) {
                if (!(error instanceof ApiError) || error.code !== 100) { throw error; }
            }
            if (!snapshot?.draft || snapshot.review.status !== 'pending' || snapshot.review.links.submitter?.title !== draft.username) {
                await this.forgetDraft(draft);
                throw new ReviewSafetyError('This draft is no longer available.');
            }
            await this.loadRemote(draft.id, undefined, draft.server, signal);
        });
    }
    private feedbackKey(comparison: RemoteComparison): string { return `feedback:${comparison.server}:${comparison.username}:${comparison.requestId}:${comparison.selected.id}`; }
    private feedbackBase(remote: RemoteComparison): string { return digest(JSON.stringify([remote.reviewerDraft, remote.reviewerComments])); }
    private async cacheFeedback(): Promise<void> {
        const remote = this.browser.current; if (!remote) { return; }
        const key = this.feedbackKey(remote), old = this.store.get<FeedbackCache>(key);
        await this.store.set(key, { feedback: this.feedback, base: this.feedbackConflict && old ? old.base : this.feedbackBase(remote),
            version: this.feedbackConflict && old ? old.version : 2 } satisfies FeedbackCache);
    }
    private async loadRemote(id: number, selection?: Pick<DiffVersion, 'scope' | 'revision'>, server = this.form.server, signal?: AbortSignal, verified?: ReviewFeedback): Promise<void> {
        const remote = await this.browser.open(server, id, selection, signal), cache = this.store.get<FeedbackCache>(this.feedbackKey(remote));
        this.discussion.clear();
        const update = this.session.plan;
        if (update?.input.reviewId && (update.input.reviewId !== id || !sameSnapshot(update.previous, remote.requestSnapshot))) { this.session.invalidate(); }
        this.selected = 'remote'; this.remoteOutdated = false; this.feedbackSession.receipt = undefined;
        this.feedbackConflict = !!cache && cache.base !== (cache.version === 2 ? this.feedbackBase(remote) : digest(JSON.stringify(remote.reviewerDraft))) && !verified;
        this.feedback = verified ?? cache?.feedback ?? { ...emptyFeedback(), body: remote.reviewerDraft?.body_top ?? '', shipIt: remote.reviewerDraft?.ship_it ?? false };
        await this.store.set('lastRequest', { id, server: remote.server });
        if (remote.requestSnapshot?.draft && remote.review.status === 'pending') {
            await this.store.set('lastDraft', { id, server: remote.server, username: remote.username } satisfies LastDraft);
        } else { await this.forgetDraft({ id, server: remote.server, username: remote.username }); }
    }
    /** Refresh metadata and discussions, preserving the code snapshot and open input editors. */
    async pollRemote(signal?: AbortSignal): Promise<void> {
        if (this.polling) { return this.polling; }
        const remote = this.browser.current, connection = this.connectionVersion;
        if (this.pluginMode !== 'full' || !remote || this.busy || this.pending) { return; }
        const job = (async () => {
            const watch = await this.backend(remote.server).watch([], remote.requestId, signal), probe = watch.selected;
            if (watch.username !== remote.username || !probe) { throw new Error('Account changed during request refresh.'); }
            const token = probeToken(probe);
            if (token === remote.serverToken) { return; }
            const reader = new ReviewBrowser(server => this.backend(server));
            let next: RemoteComparison;
            try { next = await reader.open(remote.server, remote.requestId, remote.selected, signal); }
            catch (error) {
                if (!(error instanceof ComparisonVersionError)) { throw error; }
                next = await reader.open(remote.server, remote.requestId, undefined, signal);
            }
            if (signal?.aborted || this.busy || this.browser.current !== remote || connection !== this.connectionVersion) { return; }
            const plan = this.session.plan;
            if (plan?.input.reviewId === remote.requestId && !sameSnapshot(plan.previous, next.requestSnapshot)) { this.session.invalidate(); }
            const latest = (value: RemoteComparison) => value.versions.map(version => `${version.scope}:${version.id}:${version.revision}`).sort().join('|');
            const sameDiff = !this.remoteOutdated && remote.selected.id === next.selected.id && remote.selected.scope === next.selected.scope && remote.patchHash === next.patchHash && latest(remote) === latest(next);
            if (!sameDiff) {
                // Existing virtual documents stay pinned to the bytes the user has seen.
                remote.review = next.review; remote.details = next.details; remote.versions = next.versions; remote.serverToken = token;
                this.remoteOutdated = true;
            } else {
                const oldBase = this.feedbackBase(remote);
                const draftChanged = oldBase !== this.feedbackBase(next);
                const local = this.feedback.body !== (remote.reviewerDraft?.body_top ?? '') || this.feedback.shipIt !== (remote.reviewerDraft?.ship_it ?? false)
                    || this.feedback.comments.length > 0 || this.inputs.hasOpen(this.root, 'review-comment');
                Object.assign(remote, next, { id: remote.id });
                if (draftChanged) {
                    this.feedbackSession.receipt = undefined;
                    if (local) {
                        this.feedbackConflict = true;
                        const key = this.feedbackKey(remote), cache = this.store.get<FeedbackCache>(key);
                        await this.store.set(key, { feedback: this.feedback, base: cache?.version === 2 ? cache.base : oldBase, version: 2 } satisfies FeedbackCache);
                    } else {
                        this.feedback = { ...emptyFeedback(), body: next.reviewerDraft?.body_top ?? '', shipIt: next.reviewerDraft?.ship_it ?? false };
                        this.feedbackConflict = false; await this.cacheFeedback();
                    }
                }
                this.remoteOutdated = false;
            }
            this.discussion.clear(); this.refreshed.fire(); this.emit();
            this.log.debug(`Request #${remote.requestId} refreshed`);
        })();
        this.polling = job;
        try { await job; } finally { if (this.polling === job) { this.polling = undefined; } }
    }
    async openRemote(id: number, selection?: Pick<DiffVersion, 'scope' | 'revision'>, server = this.form.server): Promise<boolean> {
        const success = await this.perform(`Open request #${id}`, 'review', signal => this.loadRemote(id, selection, server, signal));
        if (success && this.browser.current) { this.viewed.fire(this.browser.current); } return success;
    }
    selectRemote(): void { if (!this.busy && this.browser.current) { this.selected = 'remote'; this.emit(); this.viewed.fire(this.browser.current); } }
    async openById(): Promise<void> {
        if (this.busy) { return; }
        const value = await vscode.window.showInputBox({ title: 'Open review request', prompt: 'Request ID', validateInput: value => /^[1-9]\d*$/.test(value) ? undefined : 'Enter a positive ID' });
        if (value) { await this.openRemote(Number(value)); }
    }
    async myReviews(): Promise<boolean> {
        return this.perform('My requests', 'review', async signal => {
            const context = await this.backend().context(signal), backend = this.backend(context.server), user = await backend.username(signal);
            const reviews = await backend.list<ReviewResource>('/review-requests/', 'review_requests', { 'from-user': user, status: 'all' }, signal);
            const chosen = await vscode.window.showQuickPick(reviews.sort((a, b) => b.id - a.id).map(review => ({ label: `#${review.id} ${review.summary || 'Draft'}`, description: review.status, id: review.id })), { title: 'My requests' });
            if (chosen) { await this.loadRemote(chosen.id, undefined, context.server, signal); this.viewed.fire(this.browser.current!); }
        });
    }
    async chooseVersion(): Promise<void> {
        const remote = this.browser.current; if (!remote || this.busy) { return; }
        const choice = await vscode.window.showQuickPick(remote.versions.map(version => ({ label: `${version.scope === 'draft' ? 'Draft' : 'Published'} v${version.revision}`, picked: version.id === remote.selected.id && version.scope === remote.selected.scope, version })), { title: 'Diff version' });
        if (choice) { await this.openRemote(remote.requestId, choice.version, remote.server); }
    }
    private async rememberRecipients(value: Recipients): Promise<void> { this.form.people = value.people; this.form.groups = value.groups; await this.store.saveOwn(this.form); }
    async editRecipients(section: 'submit' | 'review'): Promise<boolean> {
        return this.perform('Choose reviewers', section, async signal => {
            const remote = this.browser.current;
            if (section === 'review' && (!remote || !this.canEditRequest)) { throw new Error('This request is read-only.'); }
            const current = section === 'review' ? requestFields(remote!.requestSnapshot!) : this.form;
            const value = await pickRecipients(this.backend(section === 'review' ? remote!.server : this.form.server), current, this.log);
            if (!value || signal.aborted) { return; }
            if (section === 'review') { await this.requestSession.edit(remote!, value, signal); await this.loadRemote(remote!.requestId, undefined, remote!.server, signal); }
            await this.rememberRecipients(value);
        });
    }
    async publishRequest(): Promise<boolean> {
        return this.perform('Publish request', 'review', async signal => {
            let remote = this.browser.current;
            if (!this.canPublishRequest || !remote?.requestSnapshot?.draft) { throw new ReviewSafetyError('Open a verified draft before publishing.'); }
            const fields = requestFields(remote.requestSnapshot), changes: Partial<RequestMetadata> = {};
            if (!fields.people.length && !fields.groups.length) {
                const reviewers = await pickRecipients(this.backend(remote.server), { people: this.form.people, groups: this.form.groups }, this.log);
                if (!reviewers || signal.aborted) { return; }
                if (!reviewers.people.length && !reviewers.groups.length) { throw new PublishValidationError('reviewers'); }
                Object.assign(changes, reviewers);
            }
            if (!fields.summary.trim()) {
                const summary = await vscode.window.showInputBox({ title: 'Request title', validateInput: value => value.trim() ? undefined : 'Enter a title' });
                if (!summary) { return; } changes.summary = summary;
            }
            if (!fields.description.trim()) { changes.description = changes.summary ?? fields.summary; }
            if (Object.keys(changes).length) {
                await this.requestSession.edit(remote, changes, signal);
                if (changes.people && changes.groups) { await this.rememberRecipients({ people: changes.people, groups: changes.groups }); }
                await this.loadRemote(remote.requestId, undefined, remote.server, signal); remote = this.browser.current!;
            }
            await this.requestSession.publish(remote, signal); await this.loadRemote(remote.requestId, undefined, remote.server, signal);
            vscode.window.setStatusBarMessage(`Published #${remote.requestId}`, 3500);
        });
    }
    async editDetails(section: 'submit' | 'review', field?: 'summary' | 'description' | 'bugs'): Promise<void> {
        if (this.busy) { return; }
        const choice = field ?? (await vscode.window.showQuickPick([{ label: 'Title', value: 'summary' as const }, { label: 'Description', value: 'description' as const }, { label: 'Bug IDs', value: 'bugs' as const }], { title: section === 'submit' ? 'Submission details' : 'Request details' }))?.value;
        if (!choice) { return; }
        const remote = this.browser.current;
        if (section === 'review' && (!remote || !this.canEditRequest)) { return; }
        const fields = section === 'submit' ? this.form : requestFields(remote!.requestSnapshot!);
        const head = await this.git.resolve(this.root, 'HEAD'); let comparisonId = remote?.id, target = remote;
        let expected = choice === 'bugs' ? fields.bugs.join(',') : fields[choice];
        const save = async (value: string) => {
            await this.idle();
            await this.perform(`Update ${choice}`, section, async signal => {
                if (section === 'review') {
                    if (this.browser.current?.id !== comparisonId) { throw new Error('Review changed. Reopen this field.'); }
                    const current = requestFields(target!.requestSnapshot!);
                    if (this.remoteOutdated || (choice === 'bugs' ? current.bugs.join(',') : current[choice]) !== expected) {
                        throw new ReviewSafetyError('This field changed on the server. Reopen it before saving.');
                    }
                    await this.requestSession.edit(target!, { [choice]: choice === 'bugs' ? ids(value) : value }, signal);
                    await this.loadRemote(target!.requestId, undefined, target!.server, signal);
                    target = this.browser.current; comparisonId = target?.id;
                    expected = choice === 'bugs' ? ids(value).join(',') : value;
                    if (choice === 'bugs') { this.form.bugs = ids(value); await this.store.saveOwn(this.form); }
                } else {
                    if (head !== await this.git.resolve(this.root, 'HEAD', signal)) { throw new Error('Branch changed. Reopen this field.'); }
                    if (choice === 'bugs') { this.form.bugs = ids(value); }
                    else {
                        this.form[choice] = value;
                        const old = this.store.get<MessageOverride>('messageOverride');
                        await this.store.set('messageOverride', { ...(old?.head === head ? old : {}), head, [choice]: value });
                    }
                    await this.store.saveOwn(this.form);
                }
            });
        };
        if (choice === 'description') { await this.inputs.edit(section === 'review' ? `review-${remote!.requestId}-description` : 'submission-description', fields.description, save, this.root); }
        else {
            const value = await vscode.window.showInputBox({ title: choice === 'summary' ? 'Title' : 'Bug IDs', value: choice === 'bugs' ? fields.bugs.join(', ') : fields.summary,
                prompt: choice === 'bugs' ? 'Comma-separated IDs' : undefined,
                validateInput: value => choice === 'summary' && (!value.trim() || value.length > 300) ? 'Use 1–300 characters' : undefined });
            if (value !== undefined) { await save(value); }
        }
    }
    async updateDiff(): Promise<boolean> {
        return this.perform('Update request diff', 'review', async signal => {
            const remote = this.browser.current; if (!remote?.requestSnapshot || !this.canEditRequest) { throw new Error('Open your pending request first.'); }
            const plan = this.session.plan;
            if (plan?.input.reviewId === remote.requestId) {
                const fields = requestFields(remote.requestSnapshot);
                await this.session.post(plan.id, plan.input, fields, signal); this.session.invalidate(); this.localPreview = undefined; this.previewPatch = undefined;
                await this.loadRemote(remote.requestId, undefined, remote.server, signal); return;
            }
            const backend = this.backend(remote.server), connection = await backend.connect(signal);
            const repository = connection.repositories.find(item => new URL(remote.review.links.repository!.href).pathname.endsWith(`/repositories/${item.id}/`));
            const normalize = (value: string) => value.replace(/^git@([^:]+):/, 'ssh://git@$1/').replace(/\.git\/?$/, '').replace(/\/$/, '');
            const remotes = (await this.git.remotes(this.root, signal)).map(normalize);
            if (!repository || (this.form.repositoryId !== repository.id && ![repository.path, repository.mirror_path].some(value => value && remotes.includes(normalize(value))))) { throw new Error('Choose the matching Git repository before updating this diff.'); }
            this.localPreview = await this.session.preview({ ...this.form, server: remote.server, repositoryId: repository.id,
                reviewId: remote.requestId, mode: remote.submissionMode ?? (remote.review.created_with_history ? 'history' : this.form.mode) }, signal);
            this.previewPatch = this.session.patch && Buffer.from(this.session.patch);
            this.selected = 'local'; this.log.info(`Previewing diff update for #${remote.requestId}. Use Save diff to upload.`);
        });
    }
    async setFeedback(body: string, shipIt: boolean): Promise<void> {
        if (this.busy || !this.canReview || body.length > 200_000 || body.includes('\0')) { return; }
        this.feedback.body = body; this.feedback.shipIt = shipIt; this.feedbackSession.receipt = undefined;
        await this.cacheFeedback(); this.emit();
    }
    async editFeedback(): Promise<void> {
        const remote = this.browser.current; if (!remote || !this.canReview || this.busy) { return; }
        await this.inputs.edit('review-comment', this.feedback.body, async body => {
            await this.idle();
            if (this.browser.current?.id !== remote.id) { throw new Error('Review changed. Reopen the comment.'); }
            await this.setFeedback(body, this.feedback.shipIt);
        }, this.root);
    }
    async addInline(comparisonId: string, comment: InlineDraft): Promise<void> {
        if (this.busy || this.browser.current?.id !== comparisonId || !this.canReview) { throw new Error('Select the latest published diff before commenting.'); }
        if (!comment.text.trim() || comment.text.length > 200_000 || comment.text.includes('\0')) { throw new Error('Comment is empty or too long.'); }
        this.feedback.comments.push(comment); this.feedbackSession.receipt = undefined; await this.cacheFeedback(); this.emit();
    }
    async removeInline(id: string): Promise<void> {
        if (this.busy) { return; }
        if (this.browser.current?.reviewerComments.some(comment => comment.extra_data.rbtflow_comment_id === id)) { throw new Error('Edit saved comments on the Review Board page.'); }
        this.feedback.comments = this.feedback.comments.filter(comment => comment.id !== id);
        this.feedbackSession.receipt = undefined; await this.cacheFeedback(); this.emit();
    }
    async saveFeedback(publish = false): Promise<boolean> {
        return this.perform(publish ? 'Publish review' : 'Save review', 'review', async signal => {
            const remote = this.browser.current; if (!remote || !this.canReview || this.feedbackConflict) { throw new ReviewSafetyError('Open the latest diff and reload the review draft before saving.'); }
            const receipt = publish ? await this.feedbackSession.publish(remote, this.feedback, signal) : await this.feedbackSession.save(remote, this.feedback, signal);
            if (receipt.published) { await this.clearPublishedFeedback(remote); }
            else { await this.cacheFeedback(); }
        });
    }
    private async clearPublishedFeedback(remote: RemoteComparison): Promise<void> {
        await this.store.set(this.feedbackKey(remote), undefined);
        this.feedback = emptyFeedback();
        this.discussion.clear();
    }
    async publishShipIts(): Promise<void> {
        const remote = this.browser.current;
        if (!remote || !this.canReview || this.busy || this.pending || this.feedbackConflict || !this.feedback.shipIt) { return; }
        const count = await vscode.window.showInputBox({
            title: 'Publish Ship Its', value: '2', prompt: `Reviews will be published as ${remote.username}`,
            validateInput: value => /^(?:[1-9]|10)$/.test(value) ? undefined : 'Enter a number from 1 to 10.',
        });
        if (!count) { return; }
        await this.perform('Publish Ship Its', 'review', async signal => {
            if (this.browser.current !== remote || !this.canReview || this.pending || this.feedbackConflict || !this.feedback.shipIt) {
                throw new ReviewSafetyError('Open the latest diff and check the review draft.');
            }
            let published = 0;
            try {
                for (let i = 0; i < Number(count); i++) {
                    signal.throwIfAborted();
                    const feedback = i === 0 ? this.feedback : { ...emptyFeedback(), shipIt: true };
                    if (i > 0 || !this.feedbackSession.receipt || this.feedbackSession.receipt.published) {
                        await this.feedbackSession.save(remote, feedback, signal);
                        this.feedback = feedback;
                        await this.cacheFeedback();
                    }
                    const receipt = await this.feedbackSession.publish(remote, feedback, signal);
                    published++;
                    this.log.info(`Published Ship It review #${receipt.id} (${published}/${count})`);
                    await this.clearPublishedFeedback(remote);
                }
            } catch (error) {
                this.log.warn(`Published ${published}/${count} Ship Its. Check any pending review before continuing.`);
                if (published && !signal.aborted) {
                    throw new ReviewSafetyError(`Published ${published}/${count} Ship Its. Check RBTFlow output before continuing.`, { cause: error });
                }
                throw error;
            }
            vscode.window.setStatusBarMessage(`Published ${published} Ship Its`, 3500);
        });
    }
    async reloadFeedback(): Promise<boolean> {
        return this.perform('Reload review draft', 'review', async signal => {
            const remote = this.browser.current; if (!remote) { return; }
            await this.store.set('feedbackBackup', { comparison: remote, feedback: this.feedback }); await this.store.set(this.feedbackKey(remote), undefined);
            await this.loadRemote(remote.requestId, remote.selected, remote.server, signal);
        });
    }
    async recover(): Promise<boolean> {
        return this.perform('Check server', 'review', async signal => {
            const submission = this.session.pending, request = this.requestSession.store.load(), review = this.feedbackSession.store.load();
            if (submission) {
                const receipt = await this.session.reconcile(signal);
                if (receipt) { await this.resetSubmission(); await this.loadRemote(receipt.id, undefined, submission.plan.server, signal); }
            }
            if (request) {
                const receipt = await this.requestSession.reconcile(signal);
                if (receipt?.applied && request.kind === 'discard' && request.scope === 'request') {
                    await this.forgetDraft({ ...receipt, username: request.comparison.username });
                    await this.clearSelection();
                } else { await this.loadRemote(request.comparison.requestId, undefined, request.comparison.server, signal); }
            }
            if (review) {
                const receipt = await this.feedbackSession.reconcile(signal);
                if (receipt) { await this.loadRemote(review.comparison.requestId, review.comparison.selected, review.comparison.server, signal, receipt.published ? emptyFeedback() : review.feedback);
                    this.feedbackSession.receipt = receipt; await this.cacheFeedback(); }
            }
        });
    }
    async discardRequest(): Promise<boolean> {
        const remote = this.browser.current;
        if (!remote || !this.canDiscardRequest) { return false; }
        return this.perform('Discard review request', 'review', async signal => {
            const draftOnly = remote.review.public && !!remote.requestSnapshot?.draft;
            const label = draftOnly ? 'Discard Draft' : 'Discard Request';
            const prompt = draftOnly ? `Discard the unpublished changes to #${remote.requestId}?` : `Mark request #${remote.requestId} as discarded?`;
            if (await vscode.window.showWarningMessage(prompt, { modal: true }, label) !== label) { return; }
            signal.throwIfAborted();
            await this.requestSession.discard(remote, signal);
            await this.forgetDraft({ id: remote.requestId, server: remote.server, username: remote.username });
            if (draftOnly) { await this.loadRemote(remote.requestId, undefined, remote.server, signal); }
            else { await this.clearSelection(); }
        });
    }
    async completeDraft(): Promise<boolean> {
        return this.perform('Complete draft', 'review', async signal => {
            const pending = this.session.pending;
            if (!pending?.id) { throw new ReviewSafetyError('Check the server first.'); }
            const receipt = await this.session.completeBinding(signal);
            await this.resetSubmission(); await this.loadRemote(receipt.id, undefined, pending.plan.server, signal);
        });
    }
    /** Leave an immutable local recovery copy; opening a request never uploads into it. */
    async continueFromConflict(id?: number): Promise<boolean> {
        return this.perform(id ? `Open request #${id}` : 'Keep draft and continue', 'review', async signal => {
            const pending = this.session.pending, conflict = this.session.conflict ?? this.retainedConflict;
            if ((!conflict && !pending?.patchMismatch) || (pending && !pending.commitConflict && !pending.patchMismatch)) {
                throw new ReviewSafetyError('Check the server first.');
            }
            if (id !== undefined) {
                if (!conflict?.requests.some(request => request.id === id)) { throw new ReviewSafetyError('The conflict changed. Check the server again.'); }
                await this.loadRemote(id, undefined, conflict.server, signal);
            }
            if (pending) {
                if (this.session.pending?.plan.id !== pending.plan.id) { throw new ReviewSafetyError('The recovery record changed. Check the server.'); }
                const history = this.store.get<{ record: PendingWrite; archivedAt: string }[]>('submissionArchives') ?? [];
                await this.store.set('submissionArchives', [...history, { record: structuredClone(pending), archivedAt: new Date().toISOString() }]);
                await this.session.pendingStore.save(undefined);
                this.log.info(`Kept uploaded draft #${pending.id}; recovery archived without server writes`);
            }
            await this.resetSubmission();
            if (id === undefined) {
                this.browser.clear(); this.discussion.clear();
                const retained = pending?.patchMismatch && pending.id ? { id: pending.id, server: pending.plan.server } : undefined;
                await this.store.set('lastRequest', retained);
            }
            this.selected = 'remote';
        });
    }
    async clearRecovery(): Promise<void> {
        if (this.busy) { return; }
        const records = [
            this.session.pending ? { label: 'Submission', clear: () => this.session.pendingStore.save(undefined) } : undefined,
            this.requestSession.store.load() ? { label: 'Request', clear: () => this.requestSession.store.save(undefined) } : undefined,
            this.feedbackSession.store.load() ? { label: 'Review', clear: () => this.feedbackSession.store.save(undefined) } : undefined,
        ].filter((item): item is NonNullable<typeof item> => !!item);
        const record = await vscode.window.showQuickPick(records, { title: 'Clear recovery record' });
        if (record && await vscode.window.showWarningMessage('Check the server before clearing this record.', { modal: true }, 'Clear') === 'Clear') {
            if (this.busy) { return; } await record.clear(); this.log.warn(`Manually cleared ${record.label.toLowerCase()} recovery for ${this.root}`); this.emit();
        }
    }
    async settings(setting?: string): Promise<void> {
        if (this.busy) { return; }
        const key = setting ?? (await vscode.window.showQuickPick([
            { label: 'Plugin mode', value: 'pluginMode', description: this.pluginMode === 'minimal' ? 'Minimal' : 'Full' },
            { label: 'Target branch', value: 'targetRef', description: this.form.targetRef },
            { label: 'Server', value: 'server', description: this.form.server || 'From RBTools configuration' },
            { label: 'Repository', value: 'repositoryId', description: this.form.repositoryId ? '#' + this.form.repositoryId : 'Match Git remote' },
            { label: 'Base', value: 'baseRef', description: this.form.baseRef || 'Merge base' },
            { label: 'Diff mode', value: 'mode', description: diffModes.find(mode => mode.value === this.form.mode)?.label },
            { label: 'RBTools path', value: 'rbtPath', description: this.backend().options.executable },
            { label: 'Timeout', value: 'timeout', description: `${(this.backend().options.timeoutMs ?? 120_000) / 1000}s` },
            { label: 'API token', value: 'token', description: 'SecretStorage' },
            ...(this.pluginMode === 'full' ? [
                { label: 'Notifications', value: 'notifications', description: (this.store.settings().notificationsEnabled ?? this.config().get('notifications.enabled', true)) ? 'On' : 'Off' },
                { label: 'Inbox interval', value: 'pollInterval', description: `${this.store.settings().pollIntervalSeconds ?? this.config().get('notifications.pollIntervalSeconds', 60)}s` },
            ] : []),
        ], { title: 'Repository settings' }))?.value;
        if (!key) { return; }
        await this.perform('Update repository settings', 'submit', async signal => {
            if (key === 'pluginMode') {
                const value = await vscode.window.showQuickPick([
                    { label: 'Minimal', description: 'Manual review actions', value: 'minimal' as const },
                    { label: 'Full', description: 'Inbox and automatic refresh', value: 'full' as const },
                ], { title: 'Plugin mode' });
                if (value) { await this.store.set('settings', { ...this.store.settings(), mode: value.value }); }
                return;
            }
            if (key === 'targetRef') {
                this.refs = await this.git.refs(this.root, signal);
                const value = await vscode.window.showQuickPick(this.refs, { title: 'Target branch' }); if (value) { this.form.targetRef = value; }
            } else if (key === 'repositoryId') {
                const connection = await this.backend().connect(signal);
                const value = await vscode.window.showQuickPick(connection.repositories.map(item => ({ label: item.name, description: `#${item.id}`, id: item.id })), { title: 'Server repository' });
                if (value) { this.form.repositoryId = value.id; }
            } else if (key === 'mode') {
                const value = await vscode.window.showQuickPick(diffModes.map(mode => ({ ...mode, picked: mode.value === this.form.mode })), { title: 'Diff mode' });
                if (value) { this.form.mode = value.value; }
            } else if (key === 'server' || key === 'baseRef') {
                const value = await vscode.window.showInputBox({ title: key === 'server' ? 'Review Board URL' : 'Base revision', value: this.form[key], prompt: key === 'server' ? 'Empty uses RBTools configuration' : 'Empty uses merge base' });
                if (value !== undefined) { if (key === 'server') { const url = serverUrl(value); if (url !== this.form.server) { this.form.repositoryId = null; } this.form.server = url; } else { this.form.baseRef = value; } }
            } else if (key === 'rbtPath' || key === 'timeout') {
                const settings = this.store.settings(), value = await vscode.window.showInputBox({ title: key === 'rbtPath' ? 'RBTools executable' : 'Timeout (seconds)', prompt: 'Empty uses VS Code settings', value: key === 'rbtPath' ? settings.rbtPath ?? '' : settings.timeoutSeconds?.toString() ?? '',
                    validateInput: value => key === 'timeout' && value && (!Number.isFinite(Number(value)) || Number(value) < 5 || Number(value) > 1800) ? 'Use 5–1800 seconds' : undefined });
                if (value !== undefined) { if (key === 'rbtPath') { settings.rbtPath = value || undefined; } else { settings.timeoutSeconds = value ? Number(value) : undefined; } await this.store.set('settings', settings); }
            } else if (key === 'token') {
                const server = await vscode.commands.executeCommand<string>('rbtflow.setToken', this.form.server);
                if (server) { if (server !== this.form.server) { this.form.repositoryId = null; } this.form.server = server; }
            } else if (key === 'notifications') {
                const value = await vscode.window.showQuickPick([{ label: 'On', value: true }, { label: 'Off', value: false }], { title: 'Review notifications' });
                if (value) { await this.store.set('settings', { ...this.store.settings(), notificationsEnabled: value.value }); }
            } else if (key === 'pollInterval') {
                const value = await vscode.window.showInputBox({ title: 'Inbox interval (seconds)', value: String(this.store.settings().pollIntervalSeconds ?? 60),
                    validateInput: value => !Number.isSafeInteger(Number(value)) || Number(value) < 30 || Number(value) > 3600 ? 'Use 30–3600 seconds' : undefined });
                if (value !== undefined) { await this.store.set('settings', { ...this.store.settings(), pollIntervalSeconds: Number(value) }); }
            }
            this.session.invalidate(); this.connectionVersion++; this.discussion.clear(); await this.store.saveOwn(this.form);
        });
    }
    dispose(): void { this.cancel(); this.session.invalidate(); this.browser.clear(); this.discussion.clear(); this.viewed.dispose(); this.refreshed.dispose(); this.changed.dispose(); }
}
