import { Link } from './model';
export interface DiscussionReview {
    id: number; public: boolean; timestamp: string; body_top: string; body_bottom: string; ship_it?: boolean;
    links: Record<string, Link>;
}
export type CommentKind = 'general' | 'diff' | 'attachment' | 'screenshot';
export function commentKindLabel(kind: DiscussionMessage['kind']): string {
    return { header: 'Summary', footer: 'Closing comment', general: 'General comment', diff: 'Line comment', attachment: 'Attachment comment', screenshot: 'Screenshot comment' }[kind];
}
export interface DiscussionComment {
    id: number; text: string; public?: boolean; timestamp?: string; first_line?: number; num_lines?: number;
    issue_opened?: boolean; issue_status?: string; interfilediff?: unknown; base_filediff_id?: number | null; extra_data?: Record<string, unknown>; links: Record<string, Link>;
}
export interface CommentLocation { requestId: number; revision: number; fileId: number; firstLine: number; numLines: number; side?: 'base' | 'head'; }
export interface DiscussionMessage {
    key: string; kind: CommentKind | 'header' | 'footer'; text: string; author: string; timestamp: string;
    issue?: string; location?: CommentLocation; path?: string; parentComment?: string; contextUnavailable?: boolean;
}
export interface DiscussionBundle { review: DiscussionReview; messages: DiscussionMessage[]; replies: DiscussionReview[]; }
export function commentLocation(comment: DiscussionComment, requestId: number): CommentLocation | undefined {
    const match = comment.links.filediff?.href.match(/\/review-requests\/(\d+)\/diffs\/(\d+)\/files\/(\d+)\/$/);
    if (!match || Number(match[1]) !== requestId || comment.interfilediff || comment.links.interfilediff || comment.base_filediff_id != null
        || !Number.isSafeInteger(comment.first_line) || !Number.isSafeInteger(comment.num_lines) || comment.first_line! < 1 || comment.num_lines! < 1) { return; }
    const side = comment.extra_data?.rbtflow_side;
    return { requestId, revision: Number(match[2]), fileId: Number(match[3]), firstLine: comment.first_line!, numLines: comment.num_lines!,
        ...(side === 'base' || side === 'head' ? { side } : {}) };
}
export function messageText(message: DiscussionMessage, requestId: number): string {
    return [`# Review #${requestId}`, '', `${message.author} · ${message.timestamp}`, '',
        ...(message.path ? [`File: ${message.path}`, ''] : []), ...(message.location ? [`Diff: v${message.location.revision} · rows ${message.location.firstLine}–${message.location.firstLine + message.location.numLines - 1}${message.location.side ? ' · ' + (message.location.side === 'base' ? 'Original' : 'Changed') : ''}`, ''] : []),
        ...(message.issue ? [`Issue: ${message.issue}`, ''] : []), ...(message.contextUnavailable ? ['File context unavailable.', ''] : []), message.text, ''].join('\n');
}
