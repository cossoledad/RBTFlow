import { createHash } from 'node:crypto';

export function digest(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}
export function patchDigest(patch: Buffer): string {
    let end = patch.length;
    while (end && patch[end - 1] === 10) { end--; }
    return digest(patch.subarray(0, end));
}

/** Review Board can return the same Git file patches in a different order. */
export function patchContentDigest(patch: Buffer): string {
    const blocks = patch.toString('latin1').split(/\n(?=diff --git )/);
    if (!blocks[0]?.startsWith('diff --git ')) { return patchDigest(patch); }
    const headers = blocks.map(block => block.split('\n', 1)[0]);
    if (new Set(headers).size !== blocks.length) { return patchDigest(patch); }
    const hashes = blocks.map(block => patchDigest(Buffer.from(block, 'latin1'))).sort();
    return digest(hashes.join('\n'));
}

export function serverUrl(value: string): string {
    if (!value.trim()) { return ''; }
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('服务器地址需为不含账号、密码、查询参数的 HTTP(S) URL。');
    }
    return url.href.replace(/\/*$/, '/');
}

export type DiffMode = 'bound' | 'squash' | 'history';
export const diffModes: { value: DiffMode; label: string; description: string }[] = [
    { value: 'bound', label: 'Final diff + HEAD', description: 'Recommended · final diff with the real commit ID for CI' },
    { value: 'squash', label: 'Squash diff', description: 'Final file diff without forcing a HEAD commit ID' },
    { value: 'history', label: 'Commit history', description: 'Individual commits · requires a linear history' },
];
export interface ReviewInput {
    server: string;
    repositoryId: number | null;
    targetRef: string;
    baseRef: string; // Empty means merge-base(target, HEAD).
    mode: DiffMode;
    reviewId: number | null;
}

export interface ReviewFields {
    summary: string;
    description: string;
    testing: string;
    people: string[];
    groups: string[];
    bugs: string[];
    branch: string;
    changeDescription: string;
}

export interface ChangedFile {
    status: string;
    oldPath: string;
    path: string;
}

export interface GitAnalysis {
    root: string;
    gitDir: string;
    commonDir: string;
    branch: string;
    head: string;
    target: string;
    base: string;
    fingerprint: string;
    dirty: boolean;
    commits: number;
    merges: number;
    linear: boolean;
    emptyCommits: boolean;
    files: ChangedFile[];
    summary: string;
    warnings: string[];
}

export interface ServerRepository { id: number; name: string; path: string; mirror_path?: string; tool: string; }
export interface Link { href: string; title?: string; }
export interface ReviewResource {
    id: number; public: boolean; status: string; created_with_history: boolean;
    last_updated: string; summary: string; description: string; testing_done: string;
    branch: string; bugs_closed: string[]; target_people: Link[]; target_groups: Link[];
    extra_data: Record<string, unknown>; links: Record<string, Link>;
    commit_id?: string | null;
}
export interface DraftResource extends Omit<ReviewResource, 'status' | 'created_with_history'> { changedescription: string; }
export interface ReviewSnapshot {
    review: ReviewResource;
    draft: DraftResource | null;
    fingerprint: string;
}

export interface ReviewPlan {
    id: string;
    input: ReviewInput;
    git: GitAnalysis;
    server: string;
    repository: ServerRepository;
    rbtVersion: string;
    serverVersion: string;
    username: string;
    patchHash: string;
    patchContentHash?: string;
    previous: ReviewSnapshot | null;
    /** Absent on journals created before the final-diff/HEAD binding contract. */
    bindingVersion?: 1;
}
export interface Receipt {
    id: number; url: string; diffRevision: number; published: boolean;
    fingerprint: string; verification: 'patch-and-metadata';
}
export interface PendingWrite {
    kind: 'post' | 'publish'; plan: ReviewPlan; fields: ReviewFields; id?: number;
    bindingCheckpoint?: ReviewSnapshot;
    fieldsSynced?: boolean;
    patchMismatch?: boolean;
    commitConflict?: CommitConflict;
}
export interface CommitConflict {
    server: string; username: string; repositoryId: number; head: string;
    requests: { id: number; author: string; public: boolean; status: string }[];
}

export class PublishValidationError extends Error {
    constructor(readonly field: 'reviewers' | 'summary' | 'description') {
        super(field === 'reviewers' ? 'Choose at least one reviewer.' : field === 'summary' ? 'Add a title.' : 'Add a description.');
        this.name = 'PublishValidationError';
    }
}
export function validatePublication(fields: ReviewFields): void {
    if (!fields.people.length && !fields.groups.length) { throw new PublishValidationError('reviewers'); }
    if (!fields.summary.trim()) { throw new PublishValidationError('summary'); }
    if (!fields.description.trim()) { throw new PublishValidationError('description'); }
}

export function validateFields(fields: ReviewFields): void {
    if (!fields.summary.trim() || fields.summary.length > 300) { throw new Error('标题不能为空，最多 300 字符。'); }
    for (const [label, list] of [['审批人', fields.people], ['审批组', fields.groups], ['bug 号', fields.bugs]] as const) {
        if (list.some(item => !item.trim() || /[,\r\n\0]/.test(item))) { throw new Error(`${label}格式无效。`); }
    }
    const values = [fields.summary, fields.description, fields.testing, fields.branch, fields.changeDescription,
        ...fields.people, ...fields.groups, ...fields.bugs];
    if (values.some(value => value.includes('\0'))) { throw new Error('表单不能包含 NUL 字符。'); }
}

export function inputKey(input: ReviewInput): string {
    return JSON.stringify({ server: serverUrl(input.server), repositoryId: input.repositoryId,
        targetRef: input.targetRef, baseRef: input.baseRef, mode: input.mode, reviewId: input.reviewId });
}
