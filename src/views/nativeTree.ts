import * as vscode from 'vscode';

export interface Action { root: string; section: 'submit' | 'review'; action: string; }
export class NativeItem extends vscode.TreeItem {
    children?: () => NativeItem[] | Promise<NativeItem[]>;
    constructor(readonly key: string, label: string, description: string, icon: string, readonly action?: Action) {
        super(label); this.description = description; this.iconPath = new vscode.ThemeIcon(icon); this.id = `${action?.root ?? ''}:${key}`;
        if (action) { this.command = { command: 'rbtflow.run', title: label, arguments: [action] }; }
    }
}
export class NativeSection implements vscode.TreeDataProvider<NativeItem>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    readonly view: vscode.TreeView<NativeItem>;
    constructor(id: string, private readonly items: () => NativeItem[]) {
        this.view = vscode.window.createTreeView(id, { treeDataProvider: this, manageCheckboxStateManually: true });
    }
    getChildren(): NativeItem[];
    getChildren(item: NativeItem): NativeItem[] | Promise<NativeItem[]>;
    getChildren(item?: NativeItem): NativeItem[] | Promise<NativeItem[]> { return item ? item.children?.() ?? [] : this.items(); }
    getTreeItem(item: NativeItem): vscode.TreeItem { return item; }
    refresh(): void { this.changed.fire(); }
    dispose(): void { this.view.dispose(); this.changed.dispose(); }
}
