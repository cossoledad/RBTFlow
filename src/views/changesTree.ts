import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChangedFile } from '../domain/model';
import { changeTree, DiffFile, DiffNode } from '../domain/fileTree';

export interface ChangeItem extends DiffFile { comparisonId: string; root: string; }
export interface FolderItem { kind: 'folder'; path: string; children: ChangeNode[]; comparisonId: string; root: string; }
export type ChangeNode = ChangeItem | FolderItem;
export type ChangesLayout = 'tree' | 'list';

export class ChangesTree implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;
    private files: ChangeItem[] = [];
    private nodes: ChangeNode[] = [];
    private readonly parents = new Map<ChangeNode, FolderItem>();
    private layout: ChangesLayout = 'tree';
    readonly view: vscode.TreeView<ChangeNode>;
    constructor() { this.view = vscode.window.createTreeView('rbtflow.changes', { treeDataProvider: this, showCollapseAll: true }); }
    update(root: string, comparisonId: string, label: string, files: ChangedFile[], layout: ChangesLayout): void {
        this.view.description = label;
        void vscode.commands.executeCommand('setContext', 'rbtflow.changesLayout', layout);
        if (this.files[0]?.root === root && this.files[0]?.comparisonId === comparisonId && this.files.length === files.length && this.layout === layout) { return; }
        this.layout = layout; this.parents.clear();
        this.files = files.map((file, index) => ({ kind: 'file', file, index, comparisonId, root }));
        const convert = (node: DiffNode, parent?: FolderItem): ChangeNode => {
            const item: ChangeNode = node.kind === 'file' ? this.files[node.index]! : { kind: 'folder', path: node.path, children: [], comparisonId, root };
            if (parent) { this.parents.set(item, parent); }
            if (item.kind === 'folder' && node.kind === 'folder') { item.children = node.children.map(child => convert(child, item)); }
            return item;
        };
        this.nodes = layout === 'tree' ? changeTree(files).map(node => convert(node)) : this.files;
        this.emitter.fire();
    }
    getFiles(): ChangeItem[] { return this.files; }
    getChildren(item?: ChangeNode): ChangeNode[] { return item ? item.kind === 'folder' ? item.children : [] : this.nodes; }
    getParent(item: ChangeNode): FolderItem | undefined { return this.parents.get(item); }
    getTreeItem(item: ChangeNode): vscode.TreeItem {
        if (item.kind === 'folder') {
            const tree = new vscode.TreeItem(path.posix.basename(item.path), vscode.TreeItemCollapsibleState.Expanded);
            tree.id = `${item.root}:folder:${item.path}`; tree.iconPath = new vscode.ThemeIcon('folder'); tree.tooltip = item.path; return tree;
        }
        const file = item.file, tree = new vscode.TreeItem(path.posix.basename(file.path));
        tree.id = `${item.root}:file:${file.path}`;
        tree.description = this.layout === 'list' ? `${path.posix.dirname(file.path) === '.' ? '' : path.posix.dirname(file.path) + ' · '}${file.status}` : file.status;
        tree.tooltip = file.oldPath === file.path ? file.path : `${file.oldPath} → ${file.path}`;
        const status = file.status[0];
        tree.iconPath = new vscode.ThemeIcon(status === 'A' ? 'diff-added' : status === 'D' ? 'diff-removed' : status === 'R' ? 'diff-renamed' : 'diff-modified',
            new vscode.ThemeColor(status === 'A' ? 'gitDecoration.addedResourceForeground' : status === 'D' ? 'gitDecoration.deletedResourceForeground' : 'gitDecoration.modifiedResourceForeground'));
        tree.command = { command: 'rbtflow.openChange', title: 'Open diff', arguments: [item] }; tree.contextValue = 'rbtflow.change'; return tree;
    }
    dispose(): void { this.view.dispose(); this.emitter.dispose(); }
}
