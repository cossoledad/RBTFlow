import { Link } from './model';
export interface DiscussionReview {
    id: number; public: boolean; timestamp: string; body_top: string; body_bottom: string; ship_it?: boolean;
    links: Record<string, Link>;
}
export type CommentKind = 'general' | 'diff' | 'attachment' | 'screenshot';
export interface DiscussionComment {
    id: number; text: string; public?: boolean; timestamp?: string; first_line?: number; num_lines?: number;
    issue_opened?: boolean; issue_status?: string; interfilediff?: unknown; links: Record<string, Link>;
}
export interface CommentLocation { requestId: number; revision: number; fileId: number; firstLine: number; numLines: number; }
export interface DiscussionMessage {
    key: string; kind: CommentKind | 'header' | 'footer'; text: string; author: string; timestamp: string;
    issue?: string; location?: CommentLocation; path?: string; parentComment?: string; contextUnavailable?: boolean;
}
export interface DiscussionBundle { review: DiscussionReview; messages: DiscussionMessage[]; replies: DiscussionReview[]; }
export function commentLocation(comment: DiscussionComment, requestId: number): CommentLocation | undefined {
    const match = comment.links.filediff?.href.match(/\/review-requests\/(\d+)\/diffs\/(\d+)\/files\/(\d+)\/$/);
    if (!match || Number(match[1]) !== requestId || comment.interfilediff || comment.links.interfilediff || !comment.first_line || !comment.num_lines) { return; }
    return { requestId, revision: Number(match[2]), fileId: Number(match[3]), firstLine: comment.first_line, numLines: comment.num_lines };
}
export function messageText(message: DiscussionMessage, requestId: number): string {
    return [`# Review #${requestId}`, '', `${message.author} · ${message.timestamp}`, '',
        ...(message.path ? [`File: ${message.path}`, ''] : []), ...(message.location ? [`Diff: v${message.location.revision}`, ''] : []),
        ...(message.issue ? [`Issue: ${message.issue}`, ''] : []), ...(message.contextUnavailable ? ['File context unavailable.', ''] : []), message.text, ''].join('\n');
}
