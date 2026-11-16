import { ChangedFile } from './model';
export interface DiffFile { kind: 'file'; file: ChangedFile; index: number; }
export interface DiffFolder { kind: 'folder'; path: string; children: DiffNode[]; }
export type DiffNode = DiffFile | DiffFolder;

/** Preserve the original file index for snapshot/comment identity in either layout. */
export function changeTree(files: ChangedFile[]): DiffNode[] {
    const root: DiffNode[] = [], folders = new Map<string, DiffFolder>();
    files.forEach((file, index) => {
        const parts = file.path.split('/'); let children = root;
        for (let end = 1; end < parts.length; end++) {
            const folderPath = parts.slice(0, end).join('/');
            let folder = folders.get(folderPath);
            if (!folder) { folder = { kind: 'folder', path: folderPath, children: [] }; folders.set(folderPath, folder); children.push(folder); }
            children = folder.children;
        }
        children.push({ kind: 'file', file, index });
    });
    const sort = (nodes: DiffNode[]) => {
        nodes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || (a.kind === 'folder' ? a.path : a.file.path).localeCompare(b.kind === 'folder' ? b.path : b.file.path));
        for (const node of nodes) { if (node.kind === 'folder') { sort(node.children); } }
    };
    sort(root); return root;
}
