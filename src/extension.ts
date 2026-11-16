import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitAdapter } from './adapters/git';
import { serverUrl } from './domain/model';
import { ReviewController } from './views/reviewController';
import { SnapshotFiles } from './views/snapshots';
import { ChangeItem, ChangesTree } from './views/changesTree';
import { ReviewSidebar } from './views/reviewSidebar';

interface GitRepository { rootUri: vscode.Uri; state: { onDidChange: vscode.Event<void> }; }
interface GitAPI { git: { path: string }; repositories: GitRepository[];
    onDidOpenRepository: vscode.Event<GitRepository>; onDidCloseRepository: vscode.Event<GitRepository>; }
interface GitExtension { getAPI(version: 1): GitAPI; }
export interface RBTFlowAPI {
    roots(): string[];
    open(root?: string): Promise<ReviewController | undefined>;
    sidebar: ReviewSidebar;
    changes: ChangesTree;
}

export async function activate(context: vscode.ExtensionContext): Promise<RBTFlowAPI | undefined> {
    if (!vscode.workspace.isTrusted) { return; }
    const log = vscode.window.createOutputChannel('RBTFlow');
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) { throw new Error('RBTFlow 需要启用 VS Code 内置 Git 扩展。'); }
    const gitAPI = (await extension.activate()).getAPI(1), git = new GitAdapter(gitAPI.git.path);
    const snapshots = new SnapshotFiles(git), changes = new ChangesTree();
    const watches = new Map<string, vscode.Disposable>();
    let roots: string[] = [], discovery = 0, disposed = false;
    const sidebar = new ReviewSidebar(context, git, snapshots, changes, log, () => roots);
    async function refresh(): Promise<void> {
        const version = ++discovery;
        const candidates = [...gitAPI.repositories.map(repo => repo.rootUri.fsPath),
            ...(vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath)];
        const results = await Promise.allSettled(candidates.map(root => git.root(root)));
        if (disposed || version !== discovery) { return; }
        roots = [...new Set(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []))].sort();
        for (const repo of gitAPI.repositories) {
            if (!watches.has(repo.rootUri.fsPath)) { watches.set(repo.rootUri.fsPath, repo.state.onDidChange(() => sidebar.invalidate(repo.rootUri.fsPath))); }
        }
        for (const [root, watch] of watches) { if (!gitAPI.repositories.some(repo => repo.rootUri.fsPath === root)) { watch.dispose(); watches.delete(root); } }
        await sidebar.repositoriesChanged();
    }
    async function open(root?: string): Promise<ReviewController | undefined> {
        if (!vscode.workspace.isTrusted) { throw new Error('请先信任工作区。'); }
        await refresh();
        if (!root) {
            const active = vscode.window.activeTextEditor?.document.uri;
            const matching = active?.scheme === 'file' ? roots.filter(candidate => {
                const relative = path.relative(candidate, active.fsPath);
                return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
            }).sort((a, b) => b.length - a.length) : [];
            root = sidebar.current?.root ?? matching[0] ?? (roots.length === 1 ? roots[0] : undefined);
            if (!root && roots.length) { root = (await vscode.window.showQuickPick(roots.map(value => ({ label: path.basename(value), description: value, value })), { placeHolder: '选择 Git 仓库' }))?.value; }
        }
        if (!root) { if (!roots.length) { void vscode.window.showInformationMessage('当前工作区没有发现 Git 仓库。'); } return; }
        return sidebar.open(root);
    }
    const command = (name: string, action: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(name, async (...args: unknown[]) => {
        try { return await action(...args); }
        catch (error) { const message = error instanceof Error ? error.message : String(error); log.appendLine(message); void vscode.window.showErrorMessage(message); }
    });
    context.subscriptions.push(log, snapshots, sidebar, changes,
        vscode.workspace.registerFileSystemProvider('rbtflow', snapshots, { isReadonly: true, isCaseSensitive: true }),
        vscode.window.registerWebviewViewProvider('rbtflow.review', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
        gitAPI.onDidOpenRepository(() => { void refresh(); }), gitAPI.onDidCloseRepository(() => { void refresh(); }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh(); }),
        command('rbtflow.openReview', root => open(typeof root === 'string' ? root : undefined)),
        command('rbtflow.chooseRepository', async () => {
            await refresh();
            const item = await vscode.window.showQuickPick(roots.map(value => ({ label: path.basename(value), description: value, value })), { placeHolder: '切换 Git 仓库 · 默认设置分别保存' });
            if (item) { return sidebar.open(item.value); }
        }),
        command('rbtflow.refresh', refresh), command('rbtflow.showLog', () => log.show()),
        command('rbtflow.settings', async () => { await (await open())?.settings(); }),
        command('rbtflow.newReview', async () => { await (await open())?.handleMessage({ type: 'new' }); }),
        command('rbtflow.myReviews', async () => { await (await open())?.handleMessage({ type: 'myReviews' }); }),
        command('rbtflow.openById', async () => {
            const controller = await open(); if (!controller) { return; }
            const id = await vscode.window.showInputBox({ prompt: '审核单 ID（自己的或他人的已发布审核）', validateInput: value => /^[1-9]\d*$/.test(value) ? undefined : '请输入正整数 ID' });
            if (id) { await controller.handleMessage({ type: 'openRemote', reviewId: Number(id) }); }
        }),
        command('rbtflow.openChange', item => sidebar.openChange(item as ChangeItem)),
        command('rbtflow.showPatch', () => sidebar.showPatch()),
        command('rbtflow.refreshComparison', async () => {
            const controller = sidebar.current; if (!controller) { return; }
            await controller.handleMessage(controller.mode === 'browse' && controller.browser.current
                ? { type: 'openRemote', reviewId: controller.browser.current.requestId }
                : { type: 'preview', form: controller.form });
        }),
        command('rbtflow.addComment', reply => sidebar.comments.add(reply as vscode.CommentReply)),
        command('rbtflow.removeComment', thread => sidebar.comments.remove(thread as vscode.CommentThread)),
        command('rbtflow.setToken', async supplied => {
            const address = await vscode.window.showInputBox({ prompt: 'Review Board 服务器 URL',
                value: typeof supplied === 'string' ? supplied : vscode.workspace.getConfiguration('rbtflow').get('serverUrl', ''),
                validateInput: value => { try { return serverUrl(value) ? undefined : '请输入 URL'; } catch (error) { return String(error); } } });
            if (!address) { return; }
            const url = serverUrl(address);
            const token = await vscode.window.showInputBox({ prompt: 'API Token（留空删除已保存的 token）', password: true, ignoreFocusOut: true });
            if (token === undefined) { return; }
            if (token) { await context.secrets.store(`token:${url}`, token); } else { await context.secrets.delete(`token:${url}`); }
            void vscode.window.showInformationMessage('API Token 已更新。'); return url;
        }),
        new vscode.Disposable(() => { disposed = true; for (const watch of watches.values()) { watch.dispose(); } }),
    );
    await refresh();
    return { roots: () => [...roots], open, sidebar, changes };
}
