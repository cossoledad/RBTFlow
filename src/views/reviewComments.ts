import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { LineMap, virtualRange } from '../domain/comparison';
import { ReviewController } from './reviewController';
import { RemoteDocument, SnapshotFiles } from './snapshots';

export class ReviewComments implements vscode.Disposable {
    readonly controller = vscode.comments.createCommentController('rbtflow', 'Review Board');
    private readonly maps = new Map<string, Promise<LineMap>>();
    private readonly threads = new Set<vscode.CommentThread>();
    private readonly shown = new Map<string, [vscode.Uri, vscode.Uri]>();
    constructor(private readonly snapshots: SnapshotFiles, private readonly active: () => ReviewController | undefined) {
        this.controller.options = { placeHolder: '填写行内意见，加入审阅草稿后统一保存和发布。', prompt: '添加审阅意见' };
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: async document => {
                const remote = snapshots.remote(document.uri);
                if (!remote || !this.current(remote)) { return []; }
                const map = await this.lineMap(remote), column = remote.side === 'base' ? 1 : 2;
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
        return active?.mode === 'browse' && active.browser.current?.id === remote.comparison.id && remote.comparison.selected.scope === 'published'
            && remote.comparison.review.status === 'pending' && !remote.comparison.files[remote.fileIndex]?.binary;
    }
    private lineMap(remote: RemoteDocument): Promise<LineMap> {
        const file = remote.comparison.files[remote.fileIndex]!;
        const key = `${remote.comparison.id}:${file.id}`;
        let promise = this.maps.get(key);
        if (!promise) { promise = remote.backend.lines(remote.comparison, file.id); this.maps.set(key, promise); }
        return promise;
    }
    async add(reply: vscode.CommentReply): Promise<void> {
        const remote = this.snapshots.remote(reply.thread.uri), active = this.active();
        if (!remote || !active || !this.current(remote) || !reply.thread.range) { throw new Error('请从当前审核版本的原生 diff 添加评论。'); }
        const map = await this.lineMap(remote), range = virtualRange(map, remote.side, reply.thread.range.start.line + 1, reply.thread.range.end.line + 1);
        const item = { id: randomUUID(), fileId: remote.comparison.files[remote.fileIndex]!.id, side: remote.side,
            ...range, text: reply.text, issueOpened: false };
        await active.addInline(remote.comparison.id, item);
        reply.thread.comments = [{ body: item.text, author: { name: remote.comparison.username }, mode: vscode.CommentMode.Preview, label: '本地草稿' }];
        reply.thread.canReply = false; reply.thread.contextValue = item.id;
        this.threads.add(reply.thread);
    }
    async remove(thread: vscode.CommentThread): Promise<void> {
        if (thread.contextValue) { await this.active()?.removeInline(thread.contextValue); }
        thread.dispose(); this.threads.delete(thread);
    }
    clear(): void { for (const thread of this.threads) { thread.dispose(); } this.threads.clear(); this.shown.clear(); this.maps.clear(); }
    async refresh(): Promise<void> { await Promise.all([...this.shown.values()].map(uris => this.show(uris))); }
    async show(uris: [vscode.Uri, vscode.Uri]): Promise<void> {
        const remote = this.snapshots.remote(uris[1]), active = this.active();
        if (!remote || !active || remote.comparison.selected.scope !== 'published' || remote.comparison.files[remote.fileIndex]!.binary) { return; }
        const [map, comments] = await Promise.all([this.lineMap(remote), remote.backend.fileComments(remote.comparison, remote.comparison.files[remote.fileIndex]!.id)]);
        if (active.browser.current?.id !== remote.comparison.id) { return; }
        this.shown.set(uris[1].toString(), uris);
        const paths = new Set(uris.map(uri => uri.toString()));
        for (const thread of this.threads) { if (paths.has(thread.uri.toString())) { thread.dispose(); this.threads.delete(thread); } }
        const make = (first: number, count: number, preferred: 'base' | 'head', text: string, author: string, label: string) => {
            const rows = map.rows.filter(row => row[0] >= first && row[0] < first + count);
            let side = preferred;
            let values = rows.flatMap(row => row[side === 'base' ? 1 : 2] === null ? [] : [row[side === 'base' ? 1 : 2]!]);
            if (!values.length) { side = side === 'base' ? 'head' : 'base'; values = rows.flatMap(row => row[side === 'base' ? 1 : 2] === null ? [] : [row[side === 'base' ? 1 : 2]!]); }
            if (!values.length) { return; }
            const firstLine = values[0]!, lastLine = values.at(-1)!;
            const thread = this.controller.createCommentThread(uris[side === 'base' ? 0 : 1], new vscode.Range(firstLine - 1, 0, lastLine - 1, 0),
                [{ body: text, author: { name: author }, mode: vscode.CommentMode.Preview, label }]);
            thread.canReply = false; this.threads.add(thread);
            return thread;
        };
        for (const comment of comments) {
            make(comment.first_line, comment.num_lines, comment.extra_data.rbtflow_side === 'base' ? 'base' : 'head', comment.text,
                comment.links.user?.title ?? 'Review Board', comment.public ? '已发布' : '服务器草稿');
        }
        const saved = new Set(comments.map(comment => comment.extra_data.rbtflow_comment_id));
        for (const comment of active.feedback.comments.filter(item => item.fileId === remote.comparison.files[remote.fileIndex]!.id && !saved.has(item.id))) {
            const thread = make(comment.firstLine, comment.numLines, comment.side, comment.text, remote.comparison.username, '本地草稿');
            if (thread) { thread.contextValue = comment.id; }
        }
    }
    dispose(): void { this.clear(); this.controller.dispose(); this.maps.clear(); }
}
