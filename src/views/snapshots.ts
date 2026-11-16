import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { GitAdapter } from '../adapters/git';
import { ReviewPlan } from '../domain/model';

export class SnapshotFiles implements vscode.FileSystemProvider {
    private readonly entries = new Map<string, { root: string; oid: string; filename: string; empty: boolean }>();
    private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changes.event;
    constructor(private readonly git: GitAdapter) {}
    watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const bytes = await this.readFile(uri);
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength, permissions: vscode.FilePermission.Readonly };
    }
    readDirectory(): [string, vscode.FileType][] { return []; }
    createDirectory(): void { throw vscode.FileSystemError.NoPermissions(); }
    writeFile(): void { throw vscode.FileSystemError.NoPermissions(); }
    delete(): void { throw vscode.FileSystemError.NoPermissions(); }
    rename(): void { throw vscode.FileSystemError.NoPermissions(); }
    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const entry = this.entries.get(uri.toString());
        if (!entry) { throw vscode.FileSystemError.FileNotFound(uri); }
        return entry.empty ? Buffer.alloc(0) : this.git.blob(entry.root, entry.oid, entry.filename);
    }
    uris(plan: ReviewPlan, index: number): [vscode.Uri, vscode.Uri] {
        const file = plan.git.files[index];
        if (!file) { throw new Error('文件不在当前预览中。'); }
        const make = (side: 'base' | 'head') => {
            const filename = side === 'base' ? file.oldPath : file.path;
            const uri = vscode.Uri.from({ scheme: 'rbtflow', path: `/${randomUUID()}/${filename}` });
            this.entries.set(uri.toString(), { root: plan.git.root, oid: side === 'base' ? plan.git.base : plan.git.head,
                filename, empty: side === 'base' ? file.status === 'A' : file.status === 'D' });
            return uri;
        };
        return [make('base'), make('head')];
    }
    dispose(): void { this.entries.clear(); this.changes.dispose(); }
}
