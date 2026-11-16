import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChangedFile } from '../domain/model';

export interface ChangeItem { index: number; file: ChangedFile; comparisonId: string; root: string; }
export class ChangesTree implements vscode.TreeDataProvider<ChangeItem>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;
    private items: ChangeItem[] = [];
    readonly view: vscode.TreeView<ChangeItem>;
    constructor() {
        this.view = vscode.window.createTreeView('rbtflow.changes', { treeDataProvider: this, showCollapseAll: false });
    }
    update(root: string, comparisonId: string, label: string, files: ChangedFile[]): void {
        if (this.items[0]?.root === root && this.items[0]?.comparisonId === comparisonId && this.items.length === files.length) { return; }
        this.items = files.map((file, index) => ({ file, index, comparisonId, root }));
        this.view.description = label;
        this.view.message = files.length ? undefined : '预览本地更改，或按 ID 打开已提交的审核。';
        this.view.badge = files.length ? { value: files.length, tooltip: '当前对比的变更文件' } : undefined;
        this.emitter.fire();
    }
    getChildren(): ChangeItem[] { return this.items; }
    getTreeItem(item: ChangeItem): vscode.TreeItem {
        const file = item.file, tree = new vscode.TreeItem(path.posix.basename(file.path));
        tree.description = `${file.status}  ${path.posix.dirname(file.path) === '.' ? '' : path.posix.dirname(file.path)}`.trim();
        tree.tooltip = file.oldPath === file.path ? file.path : `${file.oldPath} → ${file.path}`;
        const status = file.status[0];
        tree.iconPath = new vscode.ThemeIcon(status === 'A' ? 'diff-added' : status === 'D' ? 'diff-removed' : status === 'R' ? 'diff-renamed' : 'diff-modified',
            new vscode.ThemeColor(status === 'A' ? 'gitDecoration.addedResourceForeground' : status === 'D' ? 'gitDecoration.deletedResourceForeground' : 'gitDecoration.modifiedResourceForeground'));
        tree.command = { command: 'rbtflow.openChange', title: '对比文件', arguments: [item] };
        tree.contextValue = 'rbtflow.change';
        return tree;
    }
    dispose(): void { this.view.dispose(); this.emitter.dispose(); }
}
