import { randomUUID } from 'node:crypto';
import { ApiError, RBToolsAdapter } from '../adapters/rbtools';
import { DiffVersion, RemoteComparison, RemoteFile, ReviewComment, ReviewerDraft } from '../domain/comparison';
import { DraftResource, ReviewResource, ReviewSnapshot } from '../domain/model';
import { bindingKey, ServerDiff } from '../domain/submission';
import { comparisonToken } from '../domain/activity';

export class ComparisonVersionError extends Error {}
export class ReviewBrowser {
    current?: RemoteComparison;
    private generation = 0;
    constructor(private readonly backend: (server: string) => RBToolsAdapter) {}
    clear(): void { this.generation++; this.current = undefined; }
    async open(server: string, id: number, selection?: Pick<DiffVersion, 'scope' | 'revision'>, signal?: AbortSignal): Promise<RemoteComparison> {
        if (!Number.isSafeInteger(id) || id < 1) { throw new Error('请输入有效审核单 ID。'); }
        const generation = ++this.generation;
        const context = await this.backend(server).context(signal), adapter = this.backend(context.server);
        const username = await adapter.username(signal);
        let review = (await adapter.api<{ review_request: ReviewResource }>(`/review-requests/${id}/`, {}, signal)).review_request;
        const repositoryId = Number(new URL(review.links.repository!.href).pathname.match(/\/repositories\/(\d+)\/$/)?.[1]);
        if (!repositoryId) { throw new Error('审核单没有可比较的代码仓库。'); }
        const repository = await adapter.api<{ repository: { name: string; tool: string } }>(`/repositories/${repositoryId}/`, {}, signal);
        if (repository.repository.tool !== 'Git') { throw new Error('当前版本仅支持 Git 审核单。'); }
        const published = await adapter.list<ServerDiff>(`/review-requests/${id}/diffs/`, 'diffs', {}, signal);
        const versions: DiffVersion[] = published.map(version => ({ id: version.id, revision: version.revision, scope: 'published' }));
        let ownDraft: DraftResource | undefined;
        let requestSnapshot: ReviewSnapshot | null = null;
        // Never probe another author's private request draft, even as a server admin.
        if (review.links.submitter?.title === username) {
            try {
                requestSnapshot = await adapter.snapshot(id, signal); review = requestSnapshot.review; ownDraft = requestSnapshot.draft ?? undefined;
                if (ownDraft) {
                    const drafts = await adapter.list<{ id: number; revision: number }>(`/review-requests/${id}/draft/diffs/`, 'diffs', {}, signal);
                    versions.push(...drafts.map(version => ({ id: version.id, revision: version.revision, scope: 'draft' as const })));
                }
            } catch (error) { if (!(error instanceof ApiError && error.code === 100)) { throw error; } }
        }
        versions.sort((a, b) => b.revision - a.revision || (a.scope === 'draft' ? -1 : 1));
        const selected = selection ? versions.find(item => item.scope === selection.scope && item.revision === selection.revision) : versions[0];
        if (!selected) { throw new ComparisonVersionError('Diff version is no longer available.'); }
        const prefix = `/review-requests/${id}/${selected.scope === 'draft' ? 'draft/' : ''}diffs/${selected.revision}/`;
        const raw = await adapter.list<{ id: number; binary: boolean; source_file: string; dest_file: string;
            status: string; source_revision: string }>(prefix + 'files/', 'files', {}, signal);
        const files: RemoteFile[] = raw.map(file => ({ id: file.id, binary: file.binary, sourceRevision: file.source_revision,
            oldPath: file.source_file, path: file.dest_file || file.source_file,
            status: file.status === 'deleted' ? 'D' : file.status === 'moved' ? 'R' : file.status === 'copied' ? 'C' : file.source_revision === 'PRE-CREATION' ? 'A' : 'M' }));
        let reviewerDraft: ReviewerDraft | null = null;
        if (review.public) {
            try { reviewerDraft = (await adapter.api<{ review: ReviewerDraft }>(`/review-requests/${id}/reviews/draft/`, {}, signal)).review; }
            catch (error) { if (!(error instanceof ApiError && error.code === 100)) { throw error; } }
        }
        const reviewerComments = reviewerDraft ? await adapter.list<ReviewComment>(`/review-requests/${id}/reviews/${reviewerDraft.id}/diff-comments/`, 'diff_comments', {}, signal) : [];
        const patchHash = await adapter.patchHash(id, selected.revision, selected.scope, signal);
        const activity = review.public ? await adapter.activity(id, signal) : undefined;
        const marker = ownDraft?.extra_data.rbtflow_binding_version;
        const submissionMode = review.created_with_history ? 'history' : marker === 1 || marker === '1' || published.sort((a, b) => b.revision - a.revision)[0]?.extra_data?.[bindingKey] ? 'bound' : 'squash';
        if (signal?.aborted || generation !== this.generation) { throw new Error('对比结果已过期。'); }
        const result: RemoteComparison = { id: randomUUID(), kind: 'remote', server: context.server, requestId: id, username, review,
            repositoryName: repository.repository.name, selected, versions, files, reviewerDraft, reviewerComments,
            details: ownDraft ?? review, requestSnapshot, patchHash, submissionMode, activity };
        result.serverToken = comparisonToken(result);
        this.current = result;
        return result;
    }
}
