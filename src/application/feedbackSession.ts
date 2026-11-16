import { randomUUID } from 'node:crypto';
import { RBToolsAdapter } from '../adapters/rbtools';
import { digest } from '../domain/model';
import { draftRestriction, FeedbackReceipt, RemoteComparison, ReviewComment, ReviewFeedback, ReviewerDraft, ReviewWrite } from '../domain/comparison';

export interface FeedbackStore { load(): ReviewWrite | undefined; save(write: ReviewWrite | undefined): Promise<void>; }
export class FeedbackSession {
    receipt?: FeedbackReceipt;
    private busy = false;
    constructor(private readonly backend: (server: string) => RBToolsAdapter, readonly store: FeedbackStore) {}
    private async fresh(comparison: RemoteComparison, signal?: AbortSignal): Promise<void> {
        if (comparison.selected.scope !== 'published' || !comparison.review.public) { throw new Error('只能审阅已发布的差异版本。'); }
        const backend = this.backend(comparison.server);
        if (await backend.username(signal) !== comparison.username) { throw new Error('登录用户已变化，请重新打开审核。'); }
        const diffs = await backend.list<{ id: number; revision: number }>(`/review-requests/${comparison.requestId}/diffs/`, 'diffs', {}, signal);
        const latest = Math.max(...diffs.map(diff => diff.revision));
        const selected = diffs.find(diff => diff.revision === comparison.selected.revision);
        if (latest !== comparison.selected.revision || selected?.id !== comparison.selected.id) {
            throw new Error('审核单已有新版本，请切换到最新已发布版本后再保存或发布审阅。');
        }
    }
    private async result(write: ReviewWrite, id: number, signal?: AbortSignal): Promise<FeedbackReceipt> {
        const backend = this.backend(write.comparison.server);
        const review = (await backend.api<{ review: ReviewerDraft }>(`/review-requests/${write.comparison.requestId}/reviews/${id}/`, {}, signal)).review;
        const comments = await backend.list<ReviewComment>(`/review-requests/${write.comparison.requestId}/reviews/${id}/diff-comments/`, 'diff_comments', {}, signal);
        if (review.body_top !== write.feedback.body || review.ship_it !== write.feedback.shipIt || review.public !== (write.kind === 'publish')) { throw new Error('审阅结果与草稿不一致，请先核对服务器。'); }
        if (review.body_bottom !== (write.comparison.reviewerDraft?.body_bottom ?? '')) { throw new Error('服务器的审阅附加意见已变化，请核对草稿。'); }
        if (review.extra_data.rbtflow_operation_id !== write.operationId) { throw new Error('服务器审阅标记不匹配，请核对已有草稿。'); }
        for (const item of write.feedback.comments) {
            const found = comments.find(comment => comment.extra_data.rbtflow_comment_id === item.id);
            if (!found || found.text !== item.text || found.first_line !== item.firstLine || found.num_lines !== item.numLines ||
                !found.links.filediff?.href.endsWith(`/files/${item.fileId}/`) || found.extra_data.rbtflow_side !== item.side) { throw new Error('行内评论尚未完整保存，请核对服务器。'); }
        }
        const previous = write.comparison.reviewerComments ?? [];
        for (const item of previous) {
            const found = comments.find(comment => comment.id === item.id);
            if (!found || found.text !== item.text || found.first_line !== item.first_line || found.num_lines !== item.num_lines || found.links.filediff?.href !== item.links.filediff?.href) {
                throw new Error('已有行内评论发生变化，请核对服务器。');
            }
        }
        if (comments.some(comment => !previous.some(item => item.id === comment.id) && !write.feedback.comments.some(item => item.id === comment.extra_data.rbtflow_comment_id))) {
            throw new Error('服务器草稿含未核对的行内评论，请重新载入。');
        }
        return { id, requestId: write.comparison.requestId, server: write.comparison.server, published: review.public,
            fingerprint: digest(JSON.stringify({ review, comments })), operationId: write.operationId,
            diffId: write.comparison.selected.id, revision: write.comparison.selected.revision };
    }
    async save(comparison: RemoteComparison, feedback: ReviewFeedback, signal?: AbortSignal): Promise<FeedbackReceipt> {
        if (this.busy || this.store.load()) { throw new Error('有审阅操作正在执行或结果待确认，请先检查服务器。'); }
        if (draftRestriction(comparison)) { throw new Error(draftRestriction(comparison)); }
        if (feedback.body.length > 200_000 || feedback.body.includes('\0') || feedback.comments.length > 200) { throw new Error('审阅意见长度或评论数量超限。'); }
        if (!feedback.body.trim() && !feedback.shipIt && !feedback.comments.length) { throw new Error('请填写审阅意见或添加行内评论。'); }
        if (feedback.comments.some(comment => !comparison.files.some(file => file.id === comment.fileId) || !comment.text.trim() || comment.text.length > 200_000 || comment.text.includes('\0') || !Number.isSafeInteger(comment.firstLine) || !Number.isSafeInteger(comment.numLines) || comment.firstLine < 1 || comment.numLines < 1)) { throw new Error('行内评论不属于当前差异或范围无效。'); }
        this.busy = true;
        try {
            await this.fresh(comparison, signal);
            const backend = this.backend(comparison.server), current = await backend.reviewerDraft(comparison.requestId, signal);
            if (digest(JSON.stringify(current)) !== digest(JSON.stringify(comparison.reviewerDraft))) { throw new Error('审阅草稿已在其他窗口修改，请重新载入后继续。'); }
            const write: ReviewWrite = { operationId: randomUUID(), kind: 'save', comparison: structuredClone(comparison), feedback: structuredClone(feedback), reviewId: current?.id };
            await this.store.save(write);
            const id = await backend.writeReview(comparison.requestId, { action: 'save', operation_id: write.operationId,
                body: feedback.body, ship_it: feedback.shipIt, comments: feedback.comments,
                review_id: current?.id, expected_timestamp: current?.timestamp }, signal);
            write.reviewId = id; await this.store.save(write);
            this.receipt = await this.result(write, id, signal);
            comparison.reviewerDraft = await backend.reviewerDraft(comparison.requestId, signal);
            comparison.reviewerComments = await backend.list<ReviewComment>(`/review-requests/${comparison.requestId}/reviews/${id}/diff-comments/`, 'diff_comments', {}, signal);
            await this.store.save(undefined);
            return this.receipt;
        } finally { this.busy = false; }
    }
    async publish(comparison: RemoteComparison, feedback: ReviewFeedback, signal?: AbortSignal): Promise<FeedbackReceipt> {
        if (this.busy || this.store.load() || !this.receipt || this.receipt.published || this.receipt.requestId !== comparison.requestId || this.receipt.server !== comparison.server || this.receipt.diffId !== comparison.selected.id) { throw new Error('请先保存当前版本的审阅草稿。'); }
        this.busy = true;
        try {
            await this.fresh(comparison, signal);
            const write: ReviewWrite = { operationId: this.receipt.operationId, kind: 'save', comparison: structuredClone(comparison), feedback: structuredClone(feedback), reviewId: this.receipt.id };
            const saved = await this.result(write, this.receipt.id, signal);
            if (saved.fingerprint !== this.receipt.fingerprint) { throw new Error('审阅草稿已变化，请重新保存并核对。'); }
            const backend = this.backend(comparison.server), draft = await backend.reviewerDraft(comparison.requestId, signal);
            if (!draft || draft.id !== this.receipt.id) { throw new Error('审阅草稿不存在，请重新载入。'); }
            write.kind = 'publish'; await this.store.save(write);
            await backend.writeReview(comparison.requestId, { action: 'publish', review_id: draft.id, expected_timestamp: draft.timestamp }, signal);
            this.receipt = await this.result(write, draft.id, signal);
            comparison.reviewerDraft = null;
            comparison.reviewerComments = [];
            await this.store.save(undefined);
            return this.receipt;
        } finally { this.busy = false; }
    }
    async reconcile(signal?: AbortSignal): Promise<FeedbackReceipt | undefined> {
        if (this.busy) { throw new Error('审阅操作正在执行。'); }
        const write = this.store.load(); if (!write) { return this.receipt; }
        this.busy = true;
        try {
            const backend = this.backend(write.comparison.server);
            if (await backend.username(signal) !== write.comparison.username) { throw new Error('请用原审阅用户登录后核对结果。'); }
            const id = write.reviewId ?? (await backend.reviewerDraft(write.comparison.requestId, signal))?.id;
            if (!id) { throw new Error('未找到完整审阅，请检查服务器后再继续，不会自动重发。'); }
            this.receipt = await this.result(write, id, signal);
            await this.store.save(undefined);
            return this.receipt;
        } finally { this.busy = false; }
    }
}
