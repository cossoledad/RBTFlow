import * as vscode from 'vscode';
import { DiscussionIndex } from '../application/discussionSession';
import { DiscussionMessage, DiscussionReview, messageText } from '../domain/discussion';
import { RemoteComparison } from '../domain/comparison';
import { ReviewController } from './reviewController';
import { NativeItem } from './nativeTree';
import { SnapshotFiles } from './snapshots';

export interface DiscussionTarget { root: string; comparisonId: string; index: DiscussionIndex; review?: DiscussionReview; message?: DiscussionMessage; }
export class DiscussionTree {
    private readonly transcripts = new Map<string, { root: string; uri: vscode.Uri }>();
    constructor(private readonly active: () => ReviewController | undefined, private readonly snapshots: SnapshotFiles,
                private readonly log: vscode.LogOutputChannel) {}
    private current(c: ReviewController, comparison: RemoteComparison): boolean { return this.active() === c && c.browser.current?.id === comparison.id; }
    root(c: ReviewController, comparison: RemoteComparison): NativeItem {
        const item = new NativeItem('discussion', 'Comments', '', 'comment-discussion');
        item.id = `${c.root}:request:${comparison.requestId}:discussion`; item.contextValue = 'rbtflow.discussion';
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        item.children = async () => {
            try {
                const index = await c.discussion.index(comparison);
                if (!this.current(c, comparison)) { return []; }
                const target: DiscussionTarget = { root: c.root, comparisonId: comparison.id, index };
                const all = new NativeItem('allComments', 'View all comments', '', 'open-preview'); all.id = item.id + ':all';
                all.command = { command: 'rbtflow.showDiscussion', title: 'View all comments', arguments: [target] };
                return index.reviews.length ? [all, ...index.reviews.map(review => this.review(c, index, review))] : [new NativeItem('noComments', 'No published comments', '', 'comment')];
            } catch (error) { return this.failed(c, comparison, error); }
        };
        return item;
    }
    private failed(c: ReviewController, comparison: RemoteComparison, error: unknown): NativeItem[] {
        if (!this.current(c, comparison)) { return []; }
        this.log.error('Could not read discussion', error);
        const row = new NativeItem('commentsUnavailable', 'Refresh comments', 'Unavailable', 'refresh');
        row.command = { command: 'rbtflow.refreshDiscussion', title: 'Refresh comments' }; return [row];
    }
    private review(c: ReviewController, index: DiscussionIndex, review: DiscussionReview, parentId?: number): NativeItem {
        const author = review.links.user?.title ?? 'Unknown', row = new NativeItem(`discussion:${review.id}`, `${parentId ? 'Reply · ' : ''}${author}`, `${review.ship_it ? 'Ship It · ' : ''}${new Date(review.timestamp).toLocaleString()}`, parentId ? 'reply' : review.ship_it ? 'pass' : 'comment-discussion');
        row.id = `${c.root}:request:${index.comparison.requestId}:review:${parentId ?? 0}:${review.id}`;
        row.tooltip = `${author}\n${review.timestamp}${review.ship_it ? '\nShip It' : ''}`;
        row.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        row.children = async () => {
            try {
                const bundle = await c.discussion.bundle(index, review, parentId);
                if (!this.current(c, index.comparison)) { return []; }
                const messages = bundle.messages.map(message => this.message(c, index, message));
                if (!messages.length && !bundle.replies.length) { messages.push(new NativeItem('reviewNoText', review.ship_it ? 'Ship It' : 'No comment text', '', review.ship_it ? 'pass' : 'comment')); }
                return [...messages, ...bundle.replies.map(reply => this.review(c, index, reply, review.id))];
            } catch (error) { return this.failed(c, index.comparison, error); }
        };
        return row;
    }
    private message(c: ReviewController, index: DiscussionIndex, message: DiscussionMessage): NativeItem {
        const text = message.text.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 90) || 'Comment';
        const description = [message.path, message.location && `v${message.location.revision}`, message.location?.side === 'base' && 'Original', message.issue, message.contextUnavailable && 'File unavailable'].filter(Boolean).join(' · ');
        const row = new NativeItem(message.key, text, description, message.kind === 'diff' ? 'code' : message.kind === 'attachment' ? 'file' : message.kind === 'screenshot' ? 'file-media' : 'comment');
        row.id = `${c.root}:${index.comparison.requestId}:${message.key}`;
        row.tooltip = messageText(message, index.comparison.requestId);
        const target: DiscussionTarget = { root: c.root, comparisonId: index.comparison.id, index, message };
        row.command = message.location && !message.contextUnavailable
            ? { command: 'rbtflow.openCommentDiff', title: 'Open comment in diff', arguments: [target] }
            : { command: 'rbtflow.showDiscussion', title: 'Read comment', arguments: [target] };
        row.contextValue = message.location && !message.contextUnavailable ? 'rbtflow.diffComment' : 'rbtflow.discussionMessage';
        // A structured target, never a command URI parsed from comment text.
        (row as NativeItem & { discussionTarget: DiscussionTarget }).discussionTarget = target;
        return row;
    }
    target(value?: DiscussionTarget | NativeItem): DiscussionTarget | undefined {
        return value instanceof NativeItem ? (value as NativeItem & { discussionTarget?: DiscussionTarget }).discussionTarget : value;
    }
    async show(value?: DiscussionTarget | NativeItem): Promise<void> {
        const c = this.active(), target = this.target(value), comparison = c?.browser.current;
        if (!c || !comparison || (target && (target.root !== c.root || target.comparisonId !== comparison.id))) { return; }
        const content = target?.message ? messageText(target.message, comparison.requestId) : await c.discussion.transcript(comparison);
        if (!this.current(c, comparison)) { return; }
        const index = c.discussion.current;
        const key = JSON.stringify([comparison.server, comparison.username, comparison.requestId]);
        const uri = target?.message
            ? this.snapshots.content(`${index?.id}:${target.message.key}`, `review-${comparison.requestId}-comment.md`, () => Promise.resolve(Buffer.from(content)))
            : this.snapshots.liveContent(key, `review-${comparison.requestId}-comments.md`, Buffer.from(content));
        if (!target?.message) { this.transcripts.set(key, { root: c.root, uri }); }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }
    async refreshOpen(c: ReviewController): Promise<void> {
        const comparison = c.browser.current;
        if (!comparison) { return; }
        const entry = this.transcripts.get(JSON.stringify([comparison.server, comparison.username, comparison.requestId]));
        if (!entry || entry.root !== c.root || !vscode.workspace.textDocuments.some(document => document.uri.toString() === entry.uri.toString())) { return; }
        const text = await c.discussion.transcript(comparison);
        if (this.current(c, comparison)) { this.snapshots.updateLiveContent(entry.uri, Buffer.from(text)); }
    }
}
