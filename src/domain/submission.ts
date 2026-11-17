import { CommitConflict, digest, ReviewPlan, ReviewResource } from './model';

export const bindingKey = 'rbtflow_binding_v1';
export interface CommitBinding {
    version: 1; planId: string; head: string; repositoryId: number; targetBranch: string;
    diffId: number; revision: number; patchHash: string; filesHash: string;
}
export interface ServerDiff { id: number; revision: number; commit_count?: number; extra_data: Record<string, unknown>; }
export class ReviewSafetyError extends Error {}
export class CommitConflictError extends ReviewSafetyError {
    constructor(readonly conflict: CommitConflict, readonly draftId?: number) {
        super(conflict.requests.length ? `HEAD is already linked to ${conflict.requests.map(request => '#' + request.id).join(', ')}.`
            : 'HEAD is already linked to another request. Its details are not accessible.');
    }
}
export function fullCommitId(value: unknown): value is string { return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
export function fileSetHash(paths: string[]): string { return digest(JSON.stringify([...paths].sort())); }
export function bindingFor(plan: ReviewPlan, diff: Pick<ServerDiff, 'id' | 'revision'>): CommitBinding {
    return { version: 1, planId: plan.id, head: plan.git.head, repositoryId: plan.repository.id, targetBranch: plan.input.targetRef,
        diffId: diff.id, revision: diff.revision, patchHash: plan.patchHash, filesHash: fileSetHash(plan.git.files.map(file => file.path)) };
}
export function readBinding(value: unknown): CommitBinding | undefined {
    if (value === undefined || value === null) { return; }
    let data: Partial<CommitBinding>;
    try { data = (typeof value === 'string' ? JSON.parse(value) : value) as Partial<CommitBinding>; }
    catch { throw new ReviewSafetyError('Invalid commit binding. Check the server.'); }
    if (!data || data.version !== 1 || typeof data.planId !== 'string' || !data.planId || !fullCommitId(data.head)
        || !Number.isSafeInteger(data.repositoryId) || data.repositoryId! < 1 || !Number.isSafeInteger(data.diffId) || data.diffId! < 1
        || !Number.isSafeInteger(data.revision) || data.revision! < 1 || typeof data.targetBranch !== 'string' || !data.targetBranch
        || !/^[a-f0-9]{64}$/.test(data.patchHash ?? '') || !/^[a-f0-9]{64}$/.test(data.filesHash ?? '')) {
        throw new ReviewSafetyError('Invalid commit binding. Check the server.');
    }
    return data as CommitBinding;
}
export function assertBoundCommit(binding: CommitBinding, details: ReviewResource | { commit_id?: string | null; branch: string }, diff: ServerDiff): void {
    if (details.commit_id !== binding.head) { throw new ReviewSafetyError('Commit ID does not match the uploaded HEAD. Complete the draft binding.'); }
    if (details.branch !== binding.targetBranch || diff.id !== binding.diffId || diff.revision !== binding.revision || (diff.commit_count ?? 0) !== 0) {
        throw new ReviewSafetyError('The target branch or bound diff changed. Refresh and preview again.');
    }
}
