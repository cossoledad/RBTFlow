import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitAdapter } from '../adapters/git';
import { draftRestriction } from '../domain/comparison';
import { ReviewController } from './reviewController';
import { SnapshotFiles } from './snapshots';
import { ChangeItem, ChangesLayout, ChangesTree } from './changesTree';
import { ReviewComments } from './reviewComments';
import { NativeInputs } from './nativeInputs';

export interface Action { root: string; section: 'submit' | 'review'; action: string; }
export class NativeItem extends vscode.TreeItem {
    constructor(readonly key: string, label: string, description: string, icon: string, readonly action?: Action) {
        super(label); this.description = description; this.iconPath = new vscode.ThemeIcon(icon); this.id = `${action?.root ?? ''}:${key}`;
        if (action) { this.command = { command: 'rbtflow.run', title: label, arguments: [action] }; }
    }
}
class Section implements vscode.TreeDataProvider<NativeItem>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    readonly view: vscode.TreeView<NativeItem>;
    constructor(id: string, private readonly items: () => NativeItem[]) {
        this.view = vscode.window.createTreeView(id, { treeDataProvider: this, manageCheckboxStateManually: true });
    }
    getChildren(): NativeItem[] { return this.items(); }
    getTreeItem(item: NativeItem): vscode.TreeItem { return item; }
    refresh(): void { this.changed.fire(); }
    dispose(): void { this.view.dispose(); this.changed.dispose(); }
}

/** Three native views. There is no embedded browser, form, or DOM state. */
export class ReviewSidebar implements vscode.Disposable {
    private readonly controllers = new Map<string, ReviewController>();
    private readonly initializing = new Map<string, Promise<ReviewController>>();
    current?: ReviewController;
    private selection = 0;
    private comparisonId = '';
    private feedbackFingerprint = '';
    readonly comments: ReviewComments;
    readonly submit: Section;
    readonly review: Section;
    private readonly inputs: NativeInputs;
    private readonly subscriptions: vscode.Disposable[] = [];
    constructor(private readonly context: vscode.ExtensionContext, private readonly git: GitAdapter,
                private readonly snapshots: SnapshotFiles, readonly changes: ChangesTree,
                private readonly log: vscode.LogOutputChannel, private readonly roots: () => string[]) {
        this.inputs = new NativeInputs(context.globalStorageUri.fsPath, log);
        this.comments = new ReviewComments(snapshots, () => this.current);
        this.submit = new Section('rbtflow.submit', () => this.submitItems());
        this.review = new Section('rbtflow.review', () => this.reviewItems());
        this.subscriptions.push(this.review.view.onDidChangeCheckboxState(event => {
            for (const [item, state] of event.items) { if (item.key === 'shipIt' && this.current && !this.current.busy) { void this.current.setFeedback(this.current.feedback.body, state === vscode.TreeItemCheckboxState.Checked); } }
        }));
    }
    async selectDefault(focus = false): Promise<ReviewController | undefined> {
        const remembered = this.context.globalState.get<string>('lastRepository');
        const root = remembered && this.roots().includes(remembered) ? remembered : this.roots()[0];
        return root ? this.open(root, focus) : undefined;
    }
    async open(root: string, focus = true): Promise<ReviewController> {
        if (!this.roots().includes(root)) { throw new Error('Choose a workspace Git repository.'); }
        if (this.current?.busy && this.current.root !== root) { throw new Error('Wait for the current operation.'); }
        const version = ++this.selection; let controller = this.controllers.get(root);
        if (!controller) {
            let pending = this.initializing.get(root);
            if (!pending) {
                const fresh = new ReviewController(root, this.context, this.git, this.log, this.inputs);
                pending = fresh.initialize().then(() => {
                    this.controllers.set(root, fresh);
                    this.subscriptions.push(fresh.onDidChange(() => { if (this.current === fresh) { this.render(); } }));
                    return fresh;
                }).catch(error => { fresh.dispose(); throw error; }).finally(() => { this.initializing.delete(root); });
                this.initializing.set(root, pending);
            }
            controller = await pending;
        }
        if (version === this.selection) { if (this.current !== controller) { this.comments.clear(); } this.current = controller; await this.context.globalState.update('lastRepository', root); this.render(); }
        if (focus) { await vscode.commands.executeCommand('rbtflow.submit.focus'); }
        return controller;
    }
    async invalidate(root: string): Promise<void> { await this.controllers.get(root)?.invalidate(); }
    async repositoriesChanged(): Promise<void> {
        if (this.current && !this.roots().includes(this.current.root) && !this.current.busy) { this.current = undefined; this.render(); }
        if (!this.current && this.roots().length) { await this.selectDefault(); }
    }
    async reload(root: string): Promise<ReviewController> {
        if (this.controllers.get(root)?.busy) { throw new Error('Wait for the current operation.'); }
        this.controllers.get(root)?.dispose(); this.controllers.delete(root);
        if (this.current?.root === root) { this.current = undefined; }
        return this.open(root);
    }
    private item(key: string, label: string, description: string, icon: string, section: 'submit' | 'review', action?: string): NativeItem {
        const item = new NativeItem(key, label, description, icon, action && !this.current?.busy ? { root: this.current!.root, section, action } : undefined);
        item.id = `${this.current?.root ?? ''}:${section}:${key}`; return item;
    }
    private submitItems(): NativeItem[] {
        const c = this.current; if (!c) { return []; }
        const people = [...c.form.people, ...c.form.groups.map(value => '@' + value)].join(', ');
        return [this.item('branch', 'Branch', c.branch, 'git-branch', 'submit'),
            this.item('target', 'Target', c.form.targetRef || 'Choose branch', 'git-compare', 'submit', 'target'),
            this.item('reviewers', 'Reviewers', people || 'None', 'organization', 'submit', 'reviewers'),
            this.item('bugs', 'Bugs', c.form.bugs.join(', ') || 'None', 'issues', 'submit', 'bugs'),
            this.item('message', 'Message', c.form.summary || 'From commits', 'git-commit', 'submit', 'details')];
    }
    private reviewItems(): NativeItem[] {
        const c = this.current; if (!c) { return []; }
        const rows: NativeItem[] = [], remote = c.browser.current;
        if (c.pending) { rows.push(this.item('recover', 'Check server', '', 'sync', 'review', 'recover')); }
        if (!remote) { return rows; }
        const details = remote.details, reviewers = [...details.target_people.map(value => value.title!), ...details.target_groups.map(value => '@' + value.title!)];
        rows.push(this.item('request', `#${remote.requestId} ${details.summary}`, remote.review.links.submitter?.title ?? '', 'git-pull-request', 'review', 'select'),
            this.item('version', 'Version', `${remote.selected.scope === 'draft' ? 'Draft' : 'Published'} v${remote.selected.revision}`, 'versions', 'review', 'version'),
            this.item('requestReviewers', 'Reviewers', reviewers.join(', ') || 'None', 'organization', 'review', c.canEditRequest ? 'reviewers' : undefined));
        if (details.bugs_closed.length) { rows.push(this.item('requestBugs', 'Bugs', details.bugs_closed.join(', '), 'issues', 'review', c.canEditRequest ? 'bugs' : undefined)); }
        if (c.canPublishRequest) { rows.push(this.item('publishRequest', 'Publish request', '', 'cloud-upload', 'review', 'publishRequest')); }
        if (c.canEditRequest && c.session.plan?.input.reviewId === remote.requestId) { rows.push(this.item('saveDiff', 'Save diff', 'Current branch preview', 'cloud-upload', 'review', 'updateDiff')); }
        if (c.canReview) {
            rows.push(this.item('comment', 'Comment', c.feedback.body.split('\n')[0] || 'Add a comment', 'comment-discussion', 'review', 'comment'));
            const ship = this.item('shipIt', 'Ship It', '', 'pass', 'review');
            if (!c.busy) { ship.checkboxState = c.feedback.shipIt ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked; }
            rows.push(ship);
            if (c.feedbackConflict) {
                rows.push(this.item('reloadFeedback', 'Review draft changed', 'Reload', 'warning', 'review', 'reloadFeedback'));
            } else if (draftRestriction(remote)) {
                rows.push(this.item('reviewDraft', 'Review draft', 'Open in browser', 'warning', 'review', 'browser'));
            } else if (!c.feedbackSession.store.load()) {
                if (c.feedback.body.trim() || c.feedback.shipIt || c.feedback.comments.length) { rows.push(this.item('saveReview', 'Save review', '', 'save', 'review', 'saveReview')); }
                if (c.feedbackSession.receipt && !c.feedbackSession.receipt.published) { rows.push(this.item('publishReview', 'Publish review', '', 'send', 'review', 'publishReview')); }
            }
        }
        return rows;
    }
    private render(): void {
        const c = this.current, comparison = c?.comparison(), remote = c?.browser.current;
        const nextId = comparison?.kind === 'local' ? comparison.plan.id : comparison?.id ?? '';
        if (nextId !== this.comparisonId) { this.comments.clear(); this.comparisonId = nextId; }
        const fingerprint = c?.feedbackSession.receipt?.fingerprint ?? '';
        if (!c?.busy && fingerprint !== this.feedbackFingerprint) { this.feedbackFingerprint = fingerprint; void this.comments.refresh().catch(error => this.log.warn('Comment refresh failed', error)); }
        this.submit.view.description = c ? path.basename(c.root) : undefined;
        this.review.view.description = remote ? `#${remote.requestId} · ${remote.requestSnapshot?.draft ? 'Draft' : remote.review.status}` : undefined;
        const label = comparison?.kind === 'local' ? comparison.plan.input.reviewId ? `#${comparison.plan.input.reviewId} · Preview` : 'Preview'
            : comparison ? `#${comparison.requestId} · ${comparison.selected.scope === 'draft' ? 'Draft ' : ''}v${comparison.selected.revision}` : '';
        this.changes.update(c?.root ?? '', nextId, label, comparison?.kind === 'local' ? comparison.plan.git.files : comparison?.files ?? [], c?.store.get<ChangesLayout>('changesLayout') ?? 'tree');
        const contexts = { busy: !!c?.busy, hasPending: !!c?.pending, canCreate: !!c?.canCreate && !c.busy, hasReview: !!remote, canEditRequest: !!c?.canEditRequest && !c.busy,
            canPublishRequest: !!c?.canPublishRequest && !c.busy, hasComparison: !!comparison };
        for (const [key, value] of Object.entries(contexts)) { void vscode.commands.executeCommand('setContext', `rbtflow.${key}`, value); }
        this.submit.refresh(); this.review.refresh();
    }
    async run(action: Action): Promise<void> {
        const c = this.current; if (!c || c.root !== action.root || c.busy) { return; }
        if (action.action === 'target') { await c.settings('targetRef'); }
        else if (action.action === 'reviewers') { await c.editRecipients(action.section); }
        else if (action.action === 'bugs') { await c.editDetails(action.section, 'bugs'); }
        else if (action.action === 'details') { await c.editDetails(action.section); }
        else if (action.action === 'select') { c.selectRemote(); }
        else if (action.action === 'version') { await c.chooseVersion(); }
        else if (action.action === 'publishRequest') { await c.publishRequest(); }
        else if (action.action === 'updateDiff') { await c.updateDiff(); }
        else if (action.action === 'comment') { await c.editFeedback(); }
        else if (action.action === 'saveReview') { await c.saveFeedback(); }
        else if (action.action === 'publishReview') { await c.saveFeedback(true); }
        else if (action.action === 'reloadFeedback') { await c.reloadFeedback(); }
        else if (action.action === 'recover') { await c.recover(); }
        else if (action.action === 'browser') { await this.openUrl(); }
    }
    async createDraft(): Promise<void> { if (await this.current?.createDraft()) { await vscode.commands.executeCommand('rbtflow.review.focus'); } }
    async layout(value: ChangesLayout): Promise<void> { await this.current?.store.set('changesLayout', value); this.render(); }
    async openChange(item: ChangeItem): Promise<void> {
        const c = this.current, comparison = c?.comparison(), id = comparison?.kind === 'local' ? comparison.plan.id : comparison?.id;
        if (!c || !comparison || item.root !== c.root || item.comparisonId !== id || item.kind !== 'file') { throw new Error('Select a file from the current comparison.'); }
        const uris = comparison.kind === 'local' ? this.snapshots.uris(comparison.plan, item.index) : this.snapshots.remoteUris(comparison, c.backend(comparison.server), item.index);
        const title = comparison.kind === 'local' ? `${item.file.path} · Preview` : `${item.file.path} · #${comparison.requestId} v${comparison.selected.revision}`;
        await vscode.commands.executeCommand('vscode.diff', uris[0], uris[1], title);
        if (comparison.kind === 'remote') { await this.comments.show(uris); }
    }
    async showPatch(): Promise<void> {
        const c = this.current, comparison = c?.comparison(); if (!c || !comparison) { return; }
        const key = comparison.kind === 'local' ? comparison.plan.id : comparison.id;
        const patch = comparison.kind === 'local' ? c.previewPatch : undefined;
        if (comparison.kind === 'local' && !patch) { throw new Error('Refresh the preview first.'); }
        const load = comparison.kind === 'local' ? () => Promise.resolve(patch!) : () => c.backend(comparison.server).comparisonData(comparison, 0, 'patch');
        const uri = this.snapshots.content(key + ':patch', comparison.kind === 'local' ? 'preview.diff' : `review-${comparison.requestId}-v${comparison.selected.revision}.diff`, load);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }
    async openDescription(): Promise<void> {
        const remote = this.current?.browser.current; if (!remote) { return; }
        const uri = this.snapshots.content(remote.id + ':description', `review-${remote.requestId}.md`, () => Promise.resolve(Buffer.from(remote.details.description)));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }
    async openUrl(): Promise<void> { const remote = this.current?.browser.current; if (remote) { await vscode.env.openExternal(vscode.Uri.parse(`${remote.server}r/${remote.requestId}/`)); } }
    dispose(): void { this.subscriptions.forEach(value => value.dispose()); for (const c of this.controllers.values()) { c.dispose(); } this.comments.dispose(); this.inputs.dispose(); this.submit.dispose(); this.review.dispose(); }
}
