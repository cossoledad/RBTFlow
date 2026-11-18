import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitAdapter } from '../adapters/git';
import { draftRestriction, sourceRange } from '../domain/comparison';
import { ReviewController } from './reviewController';
import { SnapshotFiles } from './snapshots';
import { ChangeItem, ChangesLayout, ChangesTree } from './changesTree';
import { ReviewComments } from './reviewComments';
import { NativeInputs } from './nativeInputs';
import { Action, NativeItem, NativeSection } from './nativeTree';
import { DiscussionTarget, DiscussionTree } from './discussionTree';
import { InboxItem, InboxTarget, InboxView } from './inboxView';
export { Action, NativeItem } from './nativeTree';

/** Native views only. There is no embedded browser, form, or DOM state. */
export class ReviewSidebar implements vscode.Disposable {
    private readonly controllers = new Map<string, ReviewController>();
    private readonly initializing = new Map<string, Promise<ReviewController>>();
    current?: ReviewController;
    private selection = 0;
    private comparisonId = '';
    private feedbackFingerprint = '';
    readonly comments: ReviewComments;
    readonly submit: NativeSection;
    readonly review: NativeSection;
    readonly discussion: DiscussionTree;
    readonly inbox: InboxView;
    private readonly inputs: NativeInputs;
    private readonly subscriptions: vscode.Disposable[] = [];
    constructor(private readonly context: vscode.ExtensionContext, private readonly git: GitAdapter,
                private readonly snapshots: SnapshotFiles, readonly changes: ChangesTree,
                private readonly log: vscode.LogOutputChannel, private readonly roots: () => string[]) {
        this.inputs = new NativeInputs(context.globalStorageUri.fsPath, log);
        this.comments = new ReviewComments(snapshots, () => this.current);
        this.discussion = new DiscussionTree(() => this.current, snapshots, log);
        this.submit = new NativeSection('rbtflow.submit', () => this.submitItems());
        this.review = new NativeSection('rbtflow.review', () => this.reviewItems());
        this.inbox = new InboxView(context, () => this.current, target => this.openInbox(target), log);
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
                    this.subscriptions.push(fresh.onDidViewRequest(comparison => { void this.inbox.viewed(comparison).catch(error => this.log.warn('Could not mark request read', error)); }));
                    this.subscriptions.push(fresh.onDidRefreshRemote(() => {
                        if (this.current !== fresh) { return; }
                        this.review.refresh();
                        void this.comments.refresh().catch(error => this.log.warn('Comment refresh failed', error));
                        void this.discussion.refreshOpen(fresh).catch(error => this.log.warn('Discussion refresh failed', error));
                    }));
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
        const rows = [this.item('branch', 'Branch', c.branch, 'git-branch', 'submit'),
            this.item('target', 'Target', c.form.targetRef || 'Choose branch', 'git-compare', 'submit', 'target'),
            this.item('reviewers', 'Reviewers', people || 'None', 'organization', 'submit', 'reviewers'),
            this.item('bugs', 'Bugs', c.form.bugs.join(', ') || 'None', 'issues', 'submit', 'bugs'),
            this.item('message', 'Message', c.form.summary || 'From commits', 'git-commit', 'submit', 'details')];
        if (c.lastDraft) { rows.push(this.item('openDraft', 'Open draft', `#${c.lastDraft.id}`, 'go-to-file', 'submit', 'openDraft')); }
        const comparison = c.comparison();
        if (comparison?.kind === 'local') {
            for (const [key, value] of [['BASE', comparison.plan.git.base], ['HEAD', comparison.plan.git.head]]) {
                const row = this.item(key!, key!, value!.slice(0, 12), 'git-commit', 'submit');
                row.tooltip = `${value}\nClick to copy`; row.command = { command: 'rbtflow.copyCommit', title: 'Copy commit SHA', arguments: [value] }; rows.push(row);
            }
        }
        return rows;
    }
    private reviewItems(): NativeItem[] {
        const c = this.current; if (!c) { return []; }
        const rows: NativeItem[] = [], remote = c.browser.current;
        const pending = c.session.pending;
        if (c.pending && (!pending?.patchMismatch || c.requestSession.store.load() || c.feedbackSession.store.load())) {
            rows.push(this.item('recover', 'Check server', '', 'sync', 'review', 'recover'));
        }
        if (pending?.patchMismatch) {
            rows.push(this.item('patchMismatch', 'Diff does not match preview', `#${pending.id}`, 'warning', 'review'));
            rows.push(this.item('openUnverifiedDraft', 'Open draft', `#${pending.id}`, 'go-to-file', 'review', 'openUnverifiedDraft'));
            rows.push(this.item('keepMismatchDraft', 'Keep draft and continue', '', 'archive', 'review', 'keepConflictDraft'));
        } else if (c.retainedPatchMismatch) {
            rows.push(this.item('patchMismatch', 'Diff does not match preview', '', 'warning', 'review'));
        }
        const conflict = c.session.conflict ?? c.retainedConflict;
        if (conflict) {
            rows.push(this.item('commitConflict', 'HEAD already linked', pending?.id ? `Draft #${pending.id} kept` : '', 'warning', 'review'));
            for (const request of conflict.requests) {
                rows.push(this.item(`commitOwner:${request.id}`, `Open existing #${request.id}`, `${request.author} · ${request.status}`, 'go-to-file', 'review', `commitOwner:${request.id}`));
            }
            if (pending?.commitConflict) { rows.push(this.item('keepConflictDraft', 'Keep draft and continue', '', 'archive', 'review', 'keepConflictDraft')); }
        }
        if (pending?.kind === 'post' && pending.plan.bindingVersion && pending.bindingCheckpoint && pending.id
            && !pending.commitConflict && !pending.patchMismatch && !pending.fieldsSynced) {
            rows.push(this.item('completeDraft', 'Complete draft', `#${pending.id}`, 'check', 'review', 'completeDraft'));
        }
        if (!remote) {
            if (c.lastRequest) { rows.push(this.item('lastRequest', `Open last request #${c.lastRequest.id}`, '', 'history', 'review', 'lastRequest')); }
            return rows;
        }
        if (c.remoteOutdated) { rows.push(this.item('latest', 'New diff available', 'Open latest', 'sync', 'review', 'latest')); }
        const details = remote.details, reviewers = [...details.target_people.map(value => value.title!), ...details.target_groups.map(value => '@' + value.title!)];
        rows.push(this.item('request', `#${remote.requestId} ${details.summary}`, remote.review.links.submitter?.title ?? '', 'git-pull-request', 'review', 'select'),
            this.item('version', 'Version', `${remote.selected.scope === 'draft' ? 'Draft' : 'Published'} v${remote.selected.revision}`, 'versions', 'review', 'version'),
            this.item('requestReviewers', 'Reviewers', reviewers.join(', ') || 'None', 'organization', 'review', c.canEditRequest ? 'reviewers' : undefined));
        if (details.bugs_closed.length) { rows.push(this.item('requestBugs', 'Bugs', details.bugs_closed.join(', '), 'issues', 'review', c.canEditRequest ? 'bugs' : undefined)); }
        if (details.branch) { rows.push(this.item('requestBranch', 'Target', details.branch, 'git-branch', 'review')); }
        if (details.commit_id) {
            const commit = this.item('commitId', 'Commit', details.commit_id.slice(0, 12), 'git-commit', 'review');
            commit.tooltip = details.commit_id; commit.command = { command: 'rbtflow.copyCommit', title: 'Copy commit SHA', arguments: [details.commit_id] }; rows.push(commit);
        }
        if (remote.review.public) { rows.push(this.discussion.root(c, remote)); }
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
                if (c.feedback.shipIt && !c.pending) { rows.push(this.item('publishShipIts', 'Publish Ship Its…', '', 'pass', 'review', 'publishShipIts')); }
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
            canPublishRequest: !!c?.canPublishRequest && !c.busy, canDiscardRequest: !!c?.canDiscardRequest && !c.busy, hasComparison: !!comparison };
        for (const [key, value] of Object.entries(contexts)) { void vscode.commands.executeCommand('setContext', `rbtflow.${key}`, value); }
        this.submit.refresh(); this.review.refresh();
        this.inbox.follow(c);
    }
    async run(action: Action): Promise<void> {
        const c = this.current; if (!c || c.root !== action.root || c.busy) { return; }
        if (action.action === 'target') { await c.settings('targetRef'); }
        else if (action.action === 'openDraft') { if (await c.openDraft()) { await vscode.commands.executeCommand('rbtflow.review.focus'); } }
        else if (action.action === 'reviewers') { await c.editRecipients(action.section); }
        else if (action.action === 'bugs') { await c.editDetails(action.section, 'bugs'); }
        else if (action.action === 'details') { await c.editDetails(action.section); }
        else if (action.action === 'select') { c.selectRemote(); }
        else if (action.action === 'version') { await c.chooseVersion(); }
        else if (action.action === 'latest') { const remote = c.browser.current; if (remote) { await c.openRemote(remote.requestId, undefined, remote.server); } }
        else if (action.action === 'publishRequest') { await c.publishRequest(); }
        else if (action.action === 'updateDiff') { await c.updateDiff(); }
        else if (action.action === 'comment') { await c.editFeedback(); }
        else if (action.action === 'saveReview') { await c.saveFeedback(); }
        else if (action.action === 'publishReview') { await c.saveFeedback(true); }
        else if (action.action === 'publishShipIts') { await c.publishShipIts(); }
        else if (action.action === 'reloadFeedback') { await c.reloadFeedback(); }
        else if (action.action === 'recover') { await c.recover(); }
        else if (action.action === 'completeDraft') { await c.completeDraft(); }
        else if (/^commitOwner:[1-9]\d*$/.test(action.action)) { await c.continueFromConflict(Number(action.action.split(':')[1])); }
        else if (action.action === 'keepConflictDraft') { await c.continueFromConflict(); }
        else if (action.action === 'openUnverifiedDraft') {
            const pending = c.session.pending;
            if (pending?.patchMismatch && pending.id) { await c.openRemote(pending.id, undefined, pending.plan.server); }
        }
        else if (action.action === 'lastRequest' && c.lastRequest) { await c.openRemote(c.lastRequest.id, undefined, c.lastRequest.server); }
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
    async openInbox(value: InboxTarget | InboxItem): Promise<void> {
        const target = value instanceof InboxItem ? value.target : value;
        const c = await this.open(target.root, false);
        if (await c.openRemote(target.entry.id, undefined, target.identity.server)) {
            const comparison = c.browser.current;
            if (comparison && comparison.username === target.identity.username) { await this.inbox.viewed(comparison, target); }
            await vscode.commands.executeCommand('rbtflow.review.focus');
        }
    }
    async refreshDiscussion(): Promise<void> {
        const current = this.current; if (!current) { return; }
        current.discussion.clear(); this.review.refresh();
        await Promise.all([this.comments.refresh(), this.discussion.refreshOpen(current)]);
    }
    async openCommentDiff(value: DiscussionTarget | NativeItem): Promise<void> {
        const target = this.discussion.target(value), c = this.current, location = target?.message?.location;
        if (!target || !c || target.root !== c.root || c.browser.current?.id !== target.comparisonId || !location) { return; }
        const comparison = target.index.comparison;
        if (comparison.selected.scope !== 'published' || comparison.selected.revision !== location.revision) {
            if (!await c.openRemote(location.requestId, { scope: 'published', revision: location.revision }, comparison.server)) { return; }
        }
        const item = this.changes.getFiles().find(item => c.browser.current?.files[item.index]?.id === location.fileId);
        if (!item) { throw new Error('File no longer exists in this diff.'); }
        await this.openChange(item);
        const current = c.browser.current!, map = await c.backend(current.server).lines(current, location.fileId);
        if (this.current !== c || c.browser.current?.id !== current.id) { return; }
        const selected = sourceRange(map, location.firstLine, location.numLines, location.side);
        if (!selected) { throw new Error('The exact comment lines are unavailable in this diff.'); }
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (!(tab instanceof vscode.TabInputTextDiff)) { return; }
        const uri = selected.side === 'head' ? tab.modified : tab.original;
        const range = new vscode.Range(selected.start - 1, 0, selected.end - 1, 0);
        await vscode.commands.executeCommand(selected.side === 'head' ? 'workbench.action.compareEditor.focusPrimarySide' : 'workbench.action.compareEditor.focusSecondarySide');
        const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());
        if (editor) { editor.selection = new vscode.Selection(range.start, range.end); editor.revealRange(range, vscode.TextEditorRevealType.InCenter); }
        else { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { selection: range, preview: true }); }
        const commentId = Number(target.message?.key.match(/^diff:(\d+)$/)?.[1]);
        if (Number.isSafeInteger(commentId)) { this.comments.reveal(commentId); }
    }
    dispose(): void { this.subscriptions.forEach(value => value.dispose()); for (const c of this.controllers.values()) { c.dispose(); } this.comments.dispose(); this.inbox.dispose(); this.inputs.dispose(); this.submit.dispose(); this.review.dispose(); }
}
