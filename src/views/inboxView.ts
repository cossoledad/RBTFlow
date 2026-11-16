import * as vscode from 'vscode';
import { InboxSession, InboxStore } from '../application/inboxSession';
import { inboxEntry, InboxEntry, InboxIdentity, inboxKey, InboxState, isUnread, requestRevision, sortInbox } from '../domain/inbox';
import { RemoteComparison } from '../domain/comparison';
import { ReviewController } from './reviewController';

export interface InboxTarget { root: string; identity: InboxIdentity; entry: InboxEntry; }
export class InboxItem extends vscode.TreeItem {
    constructor(readonly target: InboxTarget, unread: boolean) {
        const { entry, identity } = target;
        super(`#${entry.id} ${entry.summary}`);
        this.id = `${inboxKey(identity)}:${entry.id}`;
        this.description = `${entry.author} · ${unread ? 'Unread' : 'Read'}`;
        this.iconPath = new vscode.ThemeIcon(unread ? 'mail' : 'mail-read', new vscode.ThemeColor(unread ? 'notificationsInfoIcon.foreground' : 'descriptionForeground'));
        this.resourceUri = vscode.Uri.from({ scheme: 'rbtflow-inbox', authority: inboxKey(identity), path: `/${entry.id}`, query: entry.fingerprint });
        this.contextValue = unread ? 'rbtflow.inboxUnread' : 'rbtflow.inboxRead';
        this.tooltip = `${entry.summary}\n${entry.author} · ${entry.repository}\n${entry.viaGroup ? 'Group review' : 'Direct review'}${entry.revision ? ' · v' + entry.revision : ''}\n${entry.updatedAt}\n${unread ? 'Unread' : 'Read'}`;
        this.command = { command: 'rbtflow.openInboxRequest', title: 'Open review', arguments: [target] };
    }
}

/** One active workspace connection; one non-overlapping poll and one deduplicated alert batch. */
export class InboxView implements vscode.TreeDataProvider<InboxItem>, vscode.FileDecorationProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly decorated = new vscode.EventEmitter<vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this.decorated.event;
    private readonly notified = new vscode.EventEmitter<InboxTarget[]>();
    readonly onDidNotify = this.notified.event;
    readonly store: InboxStore;
    readonly view: vscode.TreeView<InboxItem>;
    state?: InboxState;
    busy = false;
    private source?: ReviewController;
    private signature = '';
    private generation = 0;
    private enabled = true;
    private interval = 60;
    private first = true;
    private session?: InboxSession;
    private operation?: AbortController;
    private pending?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private readonly subscriptions: vscode.Disposable[] = [];
    constructor(context: vscode.ExtensionContext, private readonly active: () => ReviewController | undefined,
                private readonly open: (target: InboxTarget) => Promise<void>, private readonly log: vscode.LogOutputChannel) {
        this.store = new InboxStore(context.globalState);
        this.view = vscode.window.createTreeView('rbtflow.inbox', { treeDataProvider: this });
        this.subscriptions.push(vscode.window.registerFileDecorationProvider(this), vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('rbtflow.notifications')) { this.follow(this.active(), true); }
        }));
    }
    get unreadCount(): number { return this.state?.entries.filter(entry => isUnread(this.state!, entry)).length ?? 0; }
    follow(source?: ReviewController, force = false): void {
        const settings = source?.store.settings(), config = vscode.workspace.getConfiguration('rbtflow', source && vscode.Uri.file(source.root));
        const enabled = settings?.notificationsEnabled ?? config.get('notifications.enabled', true);
        const interval = settings?.pollIntervalSeconds ?? config.get('notifications.pollIntervalSeconds', 60);
        const signature = JSON.stringify([source?.root, source?.form.server, source?.connectionVersion, settings?.rbtPath, settings?.timeoutSeconds, enabled, interval]);
        if (!force && source === this.source && signature === this.signature) { return; }
        this.generation++; this.operation?.abort(); this.session?.cancel(); clearTimeout(this.timer);
        this.source = source; this.signature = signature; this.enabled = enabled; this.interval = Math.max(30, Math.min(3600, interval));
        this.state = undefined; this.pending = undefined; this.busy = false; this.first = true;
        this.view.message = enabled ? undefined : 'Auto refresh off';
        this.session = source ? new InboxSession(server => source.backend(server), this.store) : undefined;
        this.paint();
        if (source?.form.server && enabled) { void this.refresh(false); }
    }
    async refresh(notify = false): Promise<void> {
        if (this.pending) { return this.pending; }
        const source = this.source, session = this.session;
        if (!source || !session || !source.form.server) { return; }
        const version = this.generation, operation = new AbortController(); this.operation = operation;
        clearTimeout(this.timer); this.busy = true; this.paint();
        const job = (async () => {
            try {
                const result = await session.refresh(source.form.server, operation.signal);
                if (version !== this.generation || operation.signal.aborted) { return; }
                const sameAccount = this.state && inboxKey(this.state.identity) === inboxKey(result.state.identity);
                this.state = result.state;
                const alert = notify && this.enabled && !this.first && sameAccount; this.first = false;
                if (alert && result.arrivals.length) {
                    const targets = result.arrivals.map(entry => ({ root: source.root, identity: result.state.identity, entry }));
                    this.notify(targets);
                }
                this.view.message = this.enabled ? undefined : 'Auto refresh off';
                this.log.debug(`Inbox synced: ${result.state.identity.username}, ${result.state.entries.length} requests`);
            } catch (error) {
                if (version !== this.generation || operation.signal.aborted) { return; }
                if (session.identity && this.state && inboxKey(session.identity) !== inboxKey(this.state.identity)) { this.state = undefined; }
                this.view.message = 'Offline · Refresh Inbox'; this.log.warn('Inbox refresh failed', error);
            } finally {
                if (version === this.generation) {
                    this.busy = false; this.pending = undefined; this.paint();
                    if (this.enabled) { this.timer = setTimeout(() => { void this.refresh(true); }, this.interval * 1000); }
                }
            }
        })();
        this.pending = job; return job;
    }
    private notify(targets: InboxTarget[]): void {
        this.notified.fire(targets);
        const message = targets.length === 1 ? `Review update: #${targets[0]!.entry.id} ${targets[0]!.entry.summary.replace(/\s+/g, ' ').slice(0, 100)}` : `${targets.length} review updates`;
        void vscode.window.showInformationMessage(message, targets.length === 1 ? 'Open' : 'Open Inbox').then(choice => {
            if (!choice) { return; }
            if (targets.length === 1) { void this.open(targets[0]!).catch(error => this.log.error('Could not open notification', error)); }
            else { void vscode.commands.executeCommand('rbtflow.inbox.focus'); }
        });
    }
    getChildren(): InboxItem[] { return this.state && this.source ? sortInbox(this.state).map(entry => new InboxItem({ root: this.source!.root, identity: this.state!.identity, entry }, isUnread(this.state!, entry))) : []; }
    getTreeItem(item: InboxItem): vscode.TreeItem { return item; }
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== 'rbtflow-inbox' || !this.state || uri.authority !== inboxKey(this.state.identity)) { return; }
        const entry = this.state.entries.find(entry => '/' + entry.id === uri.path && entry.fingerprint === uri.query);
        if (entry && !isUnread(this.state, entry)) { return { color: new vscode.ThemeColor('list.deemphasizedForeground'), tooltip: 'Read' }; }
        return entry ? { tooltip: 'Unread' } : undefined;
    }
    private paint(): void {
        this.view.description = this.state?.identity.username;
        this.view.badge = this.unreadCount ? { value: this.unreadCount, tooltip: 'Unread review requests' } : undefined;
        if (!this.enabled && !this.state) { this.view.message = 'Auto refresh off'; }
        this.changed.fire(); this.decorated.fire(undefined);
    }
    async mark(target: InboxTarget, read: boolean): Promise<void> {
        if (!this.state || inboxKey(target.identity) !== inboxKey(this.state.identity)) { return; }
        const state = await this.store.mark(target.identity, [target.entry], read);
        if (this.state && inboxKey(state.identity) === inboxKey(this.state.identity)) { this.state = state; this.paint(); }
    }
    async markAllRead(): Promise<void> {
        const current = this.state; if (!current) { return; }
        const state = await this.store.mark(current.identity, current.entries, true);
        if (this.state && inboxKey(state.identity) === inboxKey(this.state.identity)) { this.state = state; this.paint(); }
    }
    async viewed(comparison: RemoteComparison, opened?: InboxTarget): Promise<void> {
        if (!comparison.review.public || comparison.selected.scope !== 'published' || comparison.selected.revision !== requestRevision(comparison.review)) { return; }
        const identity = { server: comparison.server, username: comparison.username }, entry = inboxEntry(comparison.review, false);
        const observations = [entry];
        if (opened && inboxKey(opened.identity) === inboxKey(identity) && opened.entry.id === entry.id) { observations.push(opened.entry); }
        const state = await this.store.mark(identity, observations, true);
        if (this.state && inboxKey(state.identity) === inboxKey(this.state.identity)) { this.state = state; this.paint(); }
    }
    dispose(): void {
        this.generation++; clearTimeout(this.timer); this.operation?.abort(); this.session?.cancel(); this.subscriptions.forEach(value => value.dispose());
        this.view.dispose(); this.changed.dispose(); this.decorated.dispose(); this.notified.dispose();
    }
}
