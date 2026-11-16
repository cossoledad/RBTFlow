import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitAdapter } from './adapters/git';
import { serverUrl } from './domain/model';
import { ReviewPanel } from './views/reviewPanel';
import { SnapshotFiles } from './views/snapshots';

// Structural subset of the documented vscode.git API (getAPI(1)).
interface GitRepository { rootUri: vscode.Uri; state: { onDidChange: vscode.Event<void> }; }
interface GitAPI { git: { path: string }; repositories: GitRepository[];
    onDidOpenRepository: vscode.Event<GitRepository>; onDidCloseRepository: vscode.Event<GitRepository>; }
interface GitExtension { getAPI(version: 1): GitAPI; }

class RepositoryTree implements vscode.TreeDataProvider<string> {
    roots: string[] = [];
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;
    update(roots: string[]): void { this.roots = roots; this.emitter.fire(); }
    getChildren(): string[] { return this.roots; }
    getTreeItem(root: string): vscode.TreeItem {
        const item = new vscode.TreeItem(path.basename(root));
        item.description = root; item.tooltip = root; item.iconPath = new vscode.ThemeIcon('repo');
        item.command = { command: 'rbtflow.openReview', title: '提交审核', arguments: [root] };
        return item;
    }
    dispose(): void { this.emitter.dispose(); }
}

export interface RBTFlowAPI { roots(): string[]; open(root?: string): Promise<ReviewPanel | undefined>; }

export async function activate(context: vscode.ExtensionContext): Promise<RBTFlowAPI | undefined> {
    if (!vscode.workspace.isTrusted) { return; }
    const log = vscode.window.createOutputChannel('RBTFlow');
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) { throw new Error('RBTFlow 需要启用 VS Code 内置 Git 扩展。'); }
    const gitAPI = (await extension.activate()).getAPI(1);
    const git = new GitAdapter(gitAPI.git.path);
    const snapshots = new SnapshotFiles(git), tree = new RepositoryTree();
    const panels = new Map<string, ReviewPanel>();
    const watches = new Map<string, vscode.Disposable>();
    let disposed = false, discovery = 0;
    async function refresh(): Promise<void> {
        const version = ++discovery;
        const candidates = [...gitAPI.repositories.map(repo => repo.rootUri.fsPath),
            ...(vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath)];
        const results = await Promise.allSettled(candidates.map(root => git.root(root)));
        const roots = [...new Set(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []))].sort();
        if (disposed || version !== discovery) { return; }
        tree.update(roots);
        for (const repo of gitAPI.repositories) {
            if (!watches.has(repo.rootUri.fsPath)) { watches.set(repo.rootUri.fsPath, repo.state.onDidChange(() => panels.get(repo.rootUri.fsPath)?.invalidate())); }
        }
        for (const [root, watch] of watches) { if (!gitAPI.repositories.some(repo => repo.rootUri.fsPath === root)) { watch.dispose(); watches.delete(root); } }
    }
    async function open(root?: string): Promise<ReviewPanel | undefined> {
        if (!vscode.workspace.isTrusted) { throw new Error('请先信任工作区。'); }
        await refresh();
        if (!root) {
            const active = vscode.window.activeTextEditor?.document.uri;
            const matching = active?.scheme === 'file' ? tree.roots.filter(candidate => {
                const relative = path.relative(candidate, active.fsPath);
                return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
            }).sort((a, b) => b.length - a.length) : [];
            root = matching[0] ?? (tree.roots.length === 1 ? tree.roots[0] : await vscode.window.showQuickPick(tree.roots, { placeHolder: '选择审核的 Git 仓库' }));
        }
        if (!root) { if (!tree.roots.length) { void vscode.window.showInformationMessage('当前工作区没有发现 Git 仓库。'); } return; }
        if (!tree.roots.includes(root)) { throw new Error('请选择当前工作区中已发现的仓库。'); }
        let panel = panels.get(root);
        if (!panel) {
            panel = new ReviewPanel(root, context, git, snapshots, log, () => tree.roots);
            panels.set(root, panel);
            context.subscriptions.push(panel.panel.onDidDispose(() => panels.delete(root!)));
        } else { panel.panel.reveal(); }
        return panel;
    }
    const command = (name: string, action: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(name, async (...args: unknown[]) => {
        try { return await action(...args); }
        catch (error) { const message = error instanceof Error ? error.message : String(error); log.appendLine(message); void vscode.window.showErrorMessage(message); }
    });
    context.subscriptions.push(log, tree, snapshots,
        vscode.workspace.registerFileSystemProvider('rbtflow', snapshots, { isReadonly: true, isCaseSensitive: true }),
        vscode.window.registerTreeDataProvider('rbtflow.repositories', tree),
        gitAPI.onDidOpenRepository(() => { void refresh(); }), gitAPI.onDidCloseRepository(() => { void refresh(); }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh(); }),
        command('rbtflow.openReview', root => open(typeof root === 'string' ? root : undefined)),
        command('rbtflow.refresh', refresh), command('rbtflow.showLog', () => log.show()),
        command('rbtflow.setToken', async supplied => {
            const address = await vscode.window.showInputBox({ prompt: 'Review Board 服务器 URL',
                value: typeof supplied === 'string' ? supplied : vscode.workspace.getConfiguration('rbtflow').get('serverUrl', ''),
                validateInput: value => { try { return serverUrl(value) ? undefined : '请输入 URL'; } catch (e) { return String(e); } } });
            if (!address) { return; }
            const url = serverUrl(address);
            const token = await vscode.window.showInputBox({ prompt: 'API Token（留空删除已保存的 token）', password: true, ignoreFocusOut: true });
            if (token === undefined) { return; }
            if (token) { await context.secrets.store(`token:${url}`, token); } else { await context.secrets.delete(`token:${url}`); }
            void vscode.window.showInformationMessage('API Token 已更新。请重新连接并预览。');
            return url;
        }),
        new vscode.Disposable(() => { disposed = true; for (const panel of panels.values()) { panel.dispose(); } for (const watch of watches.values()) { watch.dispose(); } }),
    );
    await refresh();
    return { roots: () => tree.roots, open };
}
