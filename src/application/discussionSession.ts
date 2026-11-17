import { randomUUID } from 'node:crypto';
import { RBToolsAdapter } from '../adapters/rbtools';
import { RemoteComparison } from '../domain/comparison';
import { DiscussionBundle, DiscussionComment, DiscussionMessage, DiscussionReview, commentKindLabel, commentLocation } from '../domain/discussion';

const kinds = [
    { kind: 'general' as const, key: 'general_comments', path: 'general-comments' },
    { kind: 'diff' as const, key: 'diff_comments', path: 'diff-comments' },
    { kind: 'attachment' as const, key: 'file_attachment_comments', path: 'file-attachment-comments' },
    { kind: 'screenshot' as const, key: 'screenshot_comments', path: 'screenshot-comments' },
];
export interface DiscussionIndex { id: string; comparison: RemoteComparison; reviews: DiscussionReview[]; }

/** Read public discussion lazily; failures never become a cached empty conversation. */
export class DiscussionSession {
    current?: DiscussionIndex;
    private generation = 0;
    private indexTask?: { comparisonId: string; promise: Promise<DiscussionIndex> };
    private readonly bundles = new Map<string, Promise<DiscussionBundle>>();
    private readonly files = new Map<string, Promise<string>>();
    constructor(private readonly backend: (server: string) => RBToolsAdapter) {}
    clear(): void { this.generation++; this.current = undefined; this.indexTask = undefined; this.bundles.clear(); this.files.clear(); }
    async index(comparison: RemoteComparison, signal?: AbortSignal): Promise<DiscussionIndex> {
        if (this.current?.comparison.id === comparison.id) { return this.current; }
        if (this.indexTask?.comparisonId === comparison.id) { return this.indexTask.promise; }
        this.clear(); const version = this.generation;
        const promise = (async () => {
            const backend = this.backend(comparison.server);
            if (await backend.username(signal) !== comparison.username) { throw new Error('Account changed. Refresh the request.'); }
            const reviews = comparison.review.public ? await backend.list<DiscussionReview>(`/review-requests/${comparison.requestId}/reviews/`, 'reviews', {}, signal) : [];
            if (version !== this.generation || signal?.aborted) { throw new Error('Discussion changed.'); }
            return this.current = { id: randomUUID(), comparison, reviews: reviews.filter(review => review.public).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || b.id - a.id) };
        })();
        this.indexTask = { comparisonId: comparison.id, promise };
        try { return await promise; } finally { if (this.indexTask?.promise === promise) { this.indexTask = undefined; } }
    }
    async bundle(index: DiscussionIndex, review: DiscussionReview, parentId?: number, signal?: AbortSignal): Promise<DiscussionBundle> {
        if (this.current?.id !== index.id) { throw new Error('Discussion changed. Refresh comments.'); }
        const key = `${index.id}:${parentId ?? 0}:${review.id}`; let task = this.bundles.get(key);
        if (!task) {
            task = this.loadBundle(index, review, parentId, signal).catch(error => { this.bundles.delete(key); throw error; });
            this.bundles.set(key, task);
        }
        return task;
    }
    private async filePath(index: DiscussionIndex, message: DiscussionMessage, signal?: AbortSignal): Promise<string | undefined> {
        if (!message.location) { return; }
        const location = message.location, existing = index.comparison.files.find(file => file.id === location.fileId);
        if (existing) { return existing.path; }
        const key = `${index.id}:${location.fileId}`; let pending = this.files.get(key);
        if (!pending) {
            pending = this.backend(index.comparison.server).api<{ file: { source_file: string; dest_file: string } }>(`/review-requests/${location.requestId}/diffs/${location.revision}/files/${location.fileId}/`, {}, signal)
                .then(data => data.file.dest_file || data.file.source_file).catch(error => { this.files.delete(key); throw error; });
            this.files.set(key, pending);
        }
        return pending;
    }
    private async loadBundle(index: DiscussionIndex, review: DiscussionReview, parentId?: number, signal?: AbortSignal): Promise<DiscussionBundle> {
        const c = index.comparison, backend = this.backend(c.server), prefix = `/review-requests/${c.requestId}/reviews/${parentId ?? review.id}/${parentId ? `replies/${review.id}/` : ''}`;
        const results = await Promise.all(kinds.map(async type => review.links[type.key]
            ? backend.list<DiscussionComment>(prefix + type.path + '/', type.key, {}, signal) : []));
        const replies = !parentId && review.links.replies ? (await backend.list<DiscussionReview>(prefix + 'replies/', 'replies', {}, signal)).filter(reply => reply.public) : [];
        if (this.current?.id !== index.id || signal?.aborted) { throw new Error('Discussion changed.'); }
        const author = review.links.user?.title ?? 'Unknown';
        const messages: DiscussionMessage[] = [];
        if (review.body_top) { messages.push({ key: `review:${review.id}:header`, kind: 'header', text: review.body_top, author, timestamp: review.timestamp }); }
        for (const [position, comments] of results.entries()) {
            for (const comment of comments.filter(comment => comment.public !== false)) {
                messages.push({ key: `${kinds[position]!.kind}:${comment.id}`, kind: kinds[position]!.kind,
                    text: comment.text, author: comment.links.user?.title ?? author, timestamp: comment.timestamp ?? review.timestamp,
                    location: commentLocation(comment, c.requestId), issue: comment.issue_opened ? comment.issue_status || 'open' : undefined,
                    path: comment.links.file_attachment?.title ?? comment.links.screenshot?.title ?? comment.links.filediff?.title,
                    parentComment: comment.links.reply_to?.href });
            }
        }
        // Bound expensive historical file lookups even for large conversations.
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(4, messages.length) }, async () => {
            while (cursor < messages.length) {
                const message = messages[cursor++]!;
                if (message.location) {
                    try { message.path = await this.filePath(index, message, signal); }
                    catch (error) {
                        if (signal?.aborted) { throw error; }
                        // A removed file must never hide the comment itself.
                        backend.options.log?.(`Comment file context unavailable: ${String(error)}`);
                        message.contextUnavailable = true;
                    }
                }
            }
        }));
        if (review.body_bottom) { messages.push({ key: `review:${review.id}:footer`, kind: 'footer', text: review.body_bottom, author, timestamp: review.timestamp }); }
        if (this.current?.id !== index.id) { throw new Error('Discussion changed.'); }
        return { review, messages, replies: replies.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id - b.id) };
    }
    async transcript(comparison: RemoteComparison, signal?: AbortSignal): Promise<string> {
        const index = await this.index(comparison, signal), lines = [`# Comments · Review #${comparison.requestId}`, ''];
        for (const review of [...index.reviews].reverse()) {
            const bundle = await this.bundle(index, review, undefined, signal);
            lines.push(`## ${review.links.user?.title ?? 'Unknown'} · ${review.timestamp}${review.ship_it ? ' · Ship It' : ''}`, '');
            const append = (message: DiscussionMessage) => { lines.push(`### ${commentKindLabel(message.kind)}${message.path ? ' · ' + message.path : ''}${message.location ? ' · v' + message.location.revision : ''}${message.issue ? ' · ' + message.issue : ''}`, '', message.text, ''); };
            bundle.messages.forEach(append);
            for (const reply of bundle.replies) {
                lines.push(`### Reply · ${reply.links.user?.title ?? 'Unknown'} · ${reply.timestamp}`, '');
                (await this.bundle(index, reply, review.id, signal)).messages.forEach(append);
            }
        }
        if (!index.reviews.length) { lines.push('No published comments.', ''); }
        return lines.join('\n');
    }
}
