import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { GitAdapter } from '../adapters/git';
import { ReviewPlan } from '../domain/model';
import { RemoteComparison } from '../domain/comparison';
import { RBToolsAdapter } from '../adapters/rbtools';

export interface RemoteDocument { comparison: RemoteComparison; fileIndex: number; side: 'base' | 'head'; backend: RBToolsAdapter; }
interface SnapshotEntry { load: () => Promise<Buffer>; remote?: RemoteDocument; cached?: Buffer; pending?: Promise<Buffer>; }

export class SnapshotFiles implements vscode.FileSystemProvider {
    private readonly entries = new Map<string, SnapshotEntry>();
    private readonly pairs = new Map<string, [vscode.Uri, vscode.Uri]>();
    private cachedBytes = 0;
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
        if (entry.cached) { return entry.cached; }
        if (!entry.pending) {
            entry.pending = entry.load().then(bytes => {
                if (bytes.length > 16 * 1024 * 1024) { throw new Error('单文件超过 16 MiB，请在审核网页查看。'); }
                if (this.cachedBytes + bytes.length > 64 * 1024 * 1024) {
                    for (const value of this.entries.values()) { value.cached = undefined; }
                    this.cachedBytes = 0;
                }
                entry.cached = bytes; this.cachedBytes += bytes.length;
                return bytes;
            }).finally(() => { entry.pending = undefined; });
        }
        return entry.pending;
    }
    uris(plan: ReviewPlan, index: number): [vscode.Uri, vscode.Uri] {
        const key = `${plan.id}:${index}`, existing = this.pairs.get(key); if (existing) { return existing; }
        const file = plan.git.files[index];
        if (!file) { throw new Error('文件不在当前预览中。'); }
        const make = (side: 'base' | 'head') => {
            const filename = side === 'base' ? file.oldPath : file.path;
            const uri = vscode.Uri.from({ scheme: 'rbtflow', path: `/${filename}`, query: `snapshot=${randomUUID()}` });
            const empty = side === 'base' ? file.status === 'A' : file.status === 'D';
            this.entries.set(uri.toString(), { load: () => empty ? Promise.resolve(Buffer.alloc(0)) : this.git.blob(plan.git.root, side === 'base' ? plan.git.base : plan.git.head, filename) });
            return uri;
        };
        const result: [vscode.Uri, vscode.Uri] = [make('base'), make('head')]; this.pairs.set(key, result); return result;
    }
    remoteUris(comparison: RemoteComparison, backend: RBToolsAdapter, index: number): [vscode.Uri, vscode.Uri] {
        const key = `${comparison.id}:${index}`, existing = this.pairs.get(key); if (existing) { return existing; }
        const file = comparison.files[index]; if (!file) { throw new Error('文件不在当前审核版本中。'); }
        const make = (side: 'base' | 'head') => {
            const filename = side === 'base' ? file.oldPath : file.path;
            const uri = vscode.Uri.from({ scheme: 'rbtflow', path: `/${filename}`, query: `snapshot=${randomUUID()}` });
            const empty = side === 'base' ? file.status === 'A' : file.status === 'D';
            this.entries.set(uri.toString(), { remote: { comparison, fileIndex: index, side, backend },
                load: () => empty ? Promise.resolve(Buffer.alloc(0)) : backend.comparisonData(comparison, file.id, side) });
            return uri;
        };
        const result: [vscode.Uri, vscode.Uri] = [make('base'), make('head')]; this.pairs.set(key, result); return result;
    }
    remote(uri: vscode.Uri): RemoteDocument | undefined { return this.entries.get(uri.toString())?.remote; }
    dispose(): void { this.entries.clear(); this.pairs.clear(); this.cachedBytes = 0; this.changes.dispose(); }
}
