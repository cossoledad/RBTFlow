import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { LineMap, ReviewComment, sourceRange, virtualRange } from '../domain/comparison';
import { commentLocation } from '../domain/discussion';
import { ReviewController } from './reviewController';
import { RemoteDocument, SnapshotFiles } from './snapshots';

export class ReviewComments implements vscode.Disposable {
    readonly controller = vscode.comments.createCommentController('rbtflow', 'Review Board');
    private readonly maps = new Map<string, Promise<LineMap>>();
    private readonly threads = new Set<vscode.CommentThread>();
    private readonly shown = new Map<string, [vscode.Uri, vscode.Uri]>();
    private sequence = 0;
    private readonly loads = new Map<string, number>();
    private readonly commentThreads = new Map<number, vscode.CommentThread>();
    reveal(commentId: number): vscode.CommentThread | undefined { const thread = this.commentThreads.get(commentId); if (thread) { thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded; } return thread; }
    constructor(private readonly snapshots: SnapshotFiles, private readonly active: () => ReviewController | undefined) {
        this.controller.options = { placeHolder: 'Add a comment to your review draft', prompt: 'Review comment' };
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: async document => {
                const remote = snapshots.remote(document.uri);
                if (!remote || !this.current(remote)) { return []; }
                const map = await this.lineMap(remote), column = remote.side === 'base' ? 1 : 2;
                if (!this.current(remote)) { return []; }
                const lines = map.rows.flatMap(row => row[column] === null ? [] : [row[column]!]).filter(line => line > 0 && line <= document.lineCount);
                const ranges: vscode.Range[] = [];
                for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
                    const last = ranges.at(-1);
                    if (last && last.end.line + 1 === line - 1) { ranges[ranges.length - 1] = new vscode.Range(last.start, new vscode.Position(line - 1, 0)); }
                    else { ranges.push(new vscode.Range(line - 1, 0, line - 1, 0)); }
                }
                return ranges;
            },
        };
    }
    private current(remote: RemoteDocument): boolean {
        const active = this.active();
        return !!active?.canReview && active.browser.current?.id === remote.comparison.id && !remote.comparison.files[remote.fileIndex]?.binary;
    }
    private lineMap(remote: RemoteDocument): Promise<LineMap> {
        const file = remote.comparison.files[remote.fileIndex]!;
        const key = `${remote.comparison.id}:${file.id}`;
        let promise = this.maps.get(key);
        if (!promise) { promise = remote.backend.lines(remote.comparison, file.id).catch(error => { this.maps.delete(key); throw error; }); this.maps.set(key, promise); }
        return promise;
    }
    async add(reply: vscode.CommentReply): Promise<void> {
        const remote = this.snapshots.remote(reply.thread.uri), active = this.active();
        if (!remote || !active || !this.current(remote) || !reply.thread.range) { throw new Error('请从当前审核版本的原生 diff 添加评论。'); }
        const map = await this.lineMap(remote), range = virtualRange(map, remote.side, reply.thread.range.start.line + 1, reply.thread.range.end.line + 1);
        const item = { id: randomUUID(), fileId: remote.comparison.files[remote.fileIndex]!.id, side: remote.side,
            ...range, text: reply.text, issueOpened: false };
        await active.addInline(remote.comparison.id, item);
        reply.thread.comments = [{ body: item.text, author: { name: remote.comparison.username }, mode: vscode.CommentMode.Preview, label: 'Local draft' }];
        reply.thread.canReply = false; reply.thread.contextValue = item.id;
        this.threads.add(reply.thread);
    }
    async remove(thread: vscode.CommentThread): Promise<void> {
        if (thread.contextValue) { await this.active()?.removeInline(thread.contextValue); }
        thread.dispose(); this.threads.delete(thread);
    }
    clear(): void { this.sequence++; this.loads.clear(); this.commentThreads.clear(); for (const thread of this.threads) { thread.dispose(); } this.threads.clear(); this.shown.clear(); this.maps.clear(); }
    async refresh(): Promise<void> { await Promise.all([...this.shown.values()].map(uris => this.show(uris))); }
    async show(uris: [vscode.Uri, vscode.Uri]): Promise<void> {
        const remote = this.snapshots.remote(uris[1]), active = this.active();
        if (!remote || !active || remote.comparison.selected.scope !== 'published' || remote.comparison.files[remote.fileIndex]!.binary) { return; }
        const key = uris[1].toString(), sequence = ++this.sequence; this.loads.set(key, sequence); this.shown.set(key, uris);
        const [map, comments] = await Promise.all([this.lineMap(remote), remote.backend.fileComments(remote.comparison, remote.comparison.files[remote.fileIndex]!.id)]);
        if (this.active() !== active || active.browser.current?.id !== remote.comparison.id || this.loads.get(key) !== sequence) { return; }
        const paths = new Set(uris.map(uri => uri.toString()));
        for (const thread of this.threads) {
            if (paths.has(thread.uri.toString())) {
                for (const [id, known] of this.commentThreads) { if (known === thread) { this.commentThreads.delete(id); } }
                thread.dispose(); this.threads.delete(thread);
            }
        }
        const make = (first: number, count: number, preferred: 'base' | 'head', text: string, author: string, label: string) => {
            const selected = sourceRange(map, first, count, preferred); if (!selected) { return; }
            const thread = this.controller.createCommentThread(uris[selected.side === 'base' ? 0 : 1], new vscode.Range(selected.start - 1, 0, selected.end - 1, 0),
                [{ body: text, author: { name: author }, mode: vscode.CommentMode.Preview, label }]);
            thread.canReply = false; this.threads.add(thread);
            return thread;
        };
        const visible = comments.filter(comment => {
            const location = commentLocation(comment, remote.comparison.requestId);
            const receipt = active.feedbackSession.receipt;
            const draftId = remote.comparison.reviewerDraft?.id ?? (receipt && !receipt.published && receipt.requestId === remote.comparison.requestId ? receipt.id : undefined);
            const ownDraft = draftId && comment.links.self?.href.includes(`/reviews/${draftId}/diff-comments/`);
            return location?.revision === remote.comparison.selected.revision && location.fileId === remote.comparison.files[remote.fileIndex]!.id && (comment.public || ownDraft);
        });
        const groups = new Map<string, ReviewComment[]>(), byUrl = new Map(visible.map(comment => [comment.links.self?.href, comment]));
        for (const comment of visible) {
            let parent = comment, seen = new Set<number>();
            while (parent.links.reply_to && !seen.has(parent.id)) { seen.add(parent.id); const next = byUrl.get(parent.links.reply_to.href); if (!next) { break; } parent = next; }
            const groupKey = parent.links.self?.href ?? String(parent.id), group = groups.get(groupKey) ?? [];
            group.push(comment); groups.set(groupKey, group);
        }
        for (const group of groups.values()) {
            group.sort((a, b) => Number(!!a.links.reply_to) - Number(!!b.links.reply_to) || a.id - b.id);
            const first = group[0]!, thread = make(first.first_line, first.num_lines, first.extra_data.rbtflow_side === 'base' ? 'base' : 'head', first.text,
                first.links.user?.title ?? 'Review Board', first.public ? 'Published' : 'Server draft');
            if (!thread) { continue; }
            for (const comment of group) { this.commentThreads.set(comment.id, thread); }
            thread.comments = group.map(comment => ({ body: comment.text, author: { name: comment.links.user?.title ?? 'Review Board' }, mode: vscode.CommentMode.Preview,
                label: [comment.public ? 'Published' : 'Server draft', comment.issue_opened && (comment.issue_status || 'open')].filter(Boolean).join(' · '),
                timestamp: comment.timestamp && Number.isFinite(Date.parse(comment.timestamp)) ? new Date(comment.timestamp) : undefined }));
            thread.label = `v${remote.comparison.selected.revision} · ${remote.comparison.files[remote.fileIndex]!.path}`;
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
            if (group.some(comment => comment.issue_opened)) { thread.state = group.some(comment => comment.issue_opened && (comment.issue_status || 'open') === 'open') ? vscode.CommentThreadState.Unresolved : vscode.CommentThreadState.Resolved; }
        }
        const saved = new Set(visible.map(comment => comment.extra_data.rbtflow_comment_id));
        for (const comment of active.feedback.comments.filter(item => item.fileId === remote.comparison.files[remote.fileIndex]!.id && !saved.has(item.id))) {
            const thread = make(comment.firstLine, comment.numLines, comment.side, comment.text, remote.comparison.username, 'Local draft');
            if (thread && active.canReview) { thread.contextValue = comment.id; }
        }
    }
    dispose(): void { this.clear(); this.controller.dispose(); this.maps.clear(); }
}
