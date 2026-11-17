import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitAdapter } from './adapters/git';
import { serverUrl } from './domain/model';
import { ReviewController } from './views/reviewController';
import { SnapshotFiles } from './views/snapshots';
import { ChangeItem, ChangesTree } from './views/changesTree';
import { Action, ReviewSidebar } from './views/reviewSidebar';
import { InboxItem, InboxTarget } from './views/inboxView';
import { DiscussionTarget } from './views/discussionTree';
import { NativeItem } from './views/nativeTree';

interface GitRepository { rootUri: vscode.Uri; state: { onDidChange: vscode.Event<void> }; }
interface GitAPI { git: { path: string }; repositories: GitRepository[]; onDidOpenRepository: vscode.Event<GitRepository>; onDidCloseRepository: vscode.Event<GitRepository>; }
interface GitExtension { getAPI(version: 1): GitAPI; }
export interface RBTFlowAPI {
    roots(): string[]; open(root?: string): Promise<ReviewController | undefined>;
    sidebar: ReviewSidebar; changes: ChangesTree; log: vscode.LogOutputChannel;
}

export async function activate(context: vscode.ExtensionContext): Promise<RBTFlowAPI | undefined> {
    if (!vscode.workspace.isTrusted) { return; }
    const log = vscode.window.createOutputChannel('RBTFlow', { log: true });
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) { throw new Error('Enable the built-in Git extension.'); }
    const gitAPI = (await extension.activate()).getAPI(1), git = new GitAdapter(gitAPI.git.path);
    const snapshots = new SnapshotFiles(git), changes = new ChangesTree(), watches = new Map<string, vscode.Disposable>();
    let roots: string[] = [], discovery = 0, disposed = false;
    const sidebar = new ReviewSidebar(context, git, snapshots, changes, log, () => roots);
    async function refresh(): Promise<void> {
        const version = ++discovery;
        const candidates = [...gitAPI.repositories.map(repo => repo.rootUri.fsPath), ...(vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath)];
        const results = await Promise.allSettled(candidates.map(root => git.root(root)));
        if (disposed || version !== discovery) { return; }
        roots = [...new Set(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []))].sort();
        for (const repo of gitAPI.repositories) {
            if (!watches.has(repo.rootUri.fsPath)) {
                const result = results[candidates.indexOf(repo.rootUri.fsPath)], canonical = result?.status === 'fulfilled' ? result.value : repo.rootUri.fsPath;
                watches.set(repo.rootUri.fsPath, repo.state.onDidChange(() => { void sidebar.invalidate(canonical); }));
            }
        }
        for (const [root, watch] of watches) { if (!gitAPI.repositories.some(repo => repo.rootUri.fsPath === root)) { watch.dispose(); watches.delete(root); } }
        await sidebar.repositoriesChanged();
    }
    async function open(root?: string): Promise<ReviewController | undefined> {
        await refresh();
        if (!root) {
            const active = vscode.window.activeTextEditor?.document.uri;
            const matching = active?.scheme === 'file' ? roots.filter(candidate => { const relative = path.relative(candidate, active.fsPath); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }).sort((a, b) => b.length - a.length) : [];
            root = sidebar.current?.root ?? matching[0] ?? (roots.length === 1 ? roots[0] : undefined);
            if (!root && roots.length) { root = (await vscode.window.showQuickPick(roots.map(value => ({ label: path.basename(value), description: value, value })), { title: 'Git repository' }))?.value; }
        }
        if (!root) { if (!roots.length) { void vscode.window.showInformationMessage('Open a Git folder.'); } return; }
        return sidebar.open(root);
    }
    const command = (name: string, action: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(name, async (...args: unknown[]) => {
        try { return await action(...args); }
        catch (error) { log.error(name, error); void vscode.window.showErrorMessage('Operation failed. See RBTFlow output.', 'Show output').then(value => { if (value) { log.show(); } }); }
    });
    context.subscriptions.push(log, snapshots, sidebar, changes,
        vscode.workspace.registerFileSystemProvider('rbtflow', snapshots, { isReadonly: true, isCaseSensitive: true }),
        gitAPI.onDidOpenRepository(() => { void refresh().catch(error => log.error('Repository discovery failed', error)); }),
        gitAPI.onDidCloseRepository(() => { void refresh().catch(error => log.error('Repository discovery failed', error)); }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh().catch(error => log.error('Workspace discovery failed', error)); }),
        command('rbtflow.openReview', root => open(typeof root === 'string' ? root : undefined)),
        command('rbtflow.chooseRepository', async () => {
            await refresh(); const item = await vscode.window.showQuickPick(roots.map(value => ({ label: path.basename(value), description: value, value })), { title: 'Git repository' }); if (item) { return sidebar.open(item.value); }
        }),
        command('rbtflow.run', action => sidebar.run(action as Action)),
        command('rbtflow.copyCommit', async value => { if (typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) { await vscode.env.clipboard.writeText(value); vscode.window.setStatusBarMessage('Commit SHA copied', 2500); } }),
        command('rbtflow.preview', async () => (await open())?.preview()),
        command('rbtflow.createDraft', async () => { await open(); await sidebar.createDraft(); }),
        command('rbtflow.publishRequest', async () => sidebar.current?.publishRequest()),
        command('rbtflow.settings', async () => (await open())?.settings()),
        command('rbtflow.newReview', async () => (await open())?.newSubmission()),
        command('rbtflow.myReviews', async () => { await (await open())?.myReviews(); await vscode.commands.executeCommand('rbtflow.review.focus'); }),
        command('rbtflow.openById', async () => { await (await open())?.openById(); await vscode.commands.executeCommand('rbtflow.review.focus'); }),
        command('rbtflow.editRequest', async () => sidebar.current?.editDetails('review')),
        command('rbtflow.updateDiff', async () => sidebar.current?.updateDiff()),
        command('rbtflow.openDescription', () => sidebar.openDescription()), command('rbtflow.openUrl', () => sidebar.openUrl()),
        command('rbtflow.showDiscussion', target => sidebar.discussion.show(target as DiscussionTarget | NativeItem | undefined)),
        command('rbtflow.refreshDiscussion', () => sidebar.refreshDiscussion()),
        command('rbtflow.openCommentDiff', target => sidebar.openCommentDiff(target as DiscussionTarget | NativeItem)),
        command('rbtflow.refreshInbox', async () => { await open(); await sidebar.inbox.refresh(); }),
        command('rbtflow.openInboxRequest', target => sidebar.openInbox(target as InboxTarget | InboxItem)),
        command('rbtflow.markInboxRead', target => sidebar.inbox.mark(target instanceof InboxItem ? target.target : target as InboxTarget, true)),
        command('rbtflow.markInboxUnread', target => sidebar.inbox.mark(target instanceof InboxItem ? target.target : target as InboxTarget, false)),
        command('rbtflow.markAllInboxRead', () => sidebar.inbox.markAllRead()),
        command('rbtflow.refresh', refresh), command('rbtflow.showLog', () => log.show()),
        command('rbtflow.refreshReview', async () => { const remote = sidebar.current?.browser.current; if (remote) { await sidebar.current?.openRemote(remote.requestId, remote.selected, remote.server); } }),
        command('rbtflow.cancel', () => sidebar.current?.cancel()), command('rbtflow.recover', () => sidebar.current?.recover()),
        command('rbtflow.clearRecovery', () => sidebar.current?.clearRecovery()),
        command('rbtflow.openChange', item => sidebar.openChange(item as ChangeItem)), command('rbtflow.showPatch', () => sidebar.showPatch()),
        command('rbtflow.showTree', () => sidebar.layout('tree')), command('rbtflow.showList', () => sidebar.layout('list')),
        command('rbtflow.addComment', reply => sidebar.comments.add(reply as vscode.CommentReply)), command('rbtflow.removeComment', thread => sidebar.comments.remove(thread as vscode.CommentThread)),
        command('rbtflow.setToken', async supplied => {
            const address = await vscode.window.showInputBox({ title: 'Review Board URL', value: typeof supplied === 'string' ? supplied : vscode.workspace.getConfiguration('rbtflow').get('serverUrl', ''),
                validateInput: value => { try { return serverUrl(value) ? undefined : 'Enter a URL'; } catch { return 'Enter an HTTP(S) URL'; } } });
            if (!address) { return; } const url = serverUrl(address);
            const token = await vscode.window.showInputBox({ title: 'API token', prompt: 'Empty removes the saved token', password: true, ignoreFocusOut: true });
            if (token === undefined) { return; } if (token) { await context.secrets.store(`token:${url}`, token); } else { await context.secrets.delete(`token:${url}`); } return url;
        }),
        new vscode.Disposable(() => { disposed = true; for (const watch of watches.values()) { watch.dispose(); } }),
    );
    await refresh(); return { roots: () => [...roots], open, sidebar, changes, log };
}
