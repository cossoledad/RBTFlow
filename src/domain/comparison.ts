import { ChangedFile, DiffMode, DraftResource, Link, ReviewResource, ReviewSnapshot } from './model';
import type { PublicActivity } from './activity';

export interface DiffVersion { scope: 'draft' | 'published'; revision: number; id: number; }
export interface RemoteFile extends ChangedFile {
    id: number;
    binary: boolean;
    sourceRevision: string;
}
export interface ReviewComment {
    id: number;
    text: string;
    first_line: number;
    num_lines: number;
    public: boolean;
    extra_data: Record<string, unknown>;
    links: Record<string, Link>;
    timestamp?: string; issue_opened?: boolean; issue_status?: string; interfilediff?: unknown; base_filediff_id?: number | null;
}
export interface ReviewerDraft {
    id: number;
    public: boolean;
    body_top: string;
    body_bottom: string;
    ship_it: boolean;
    timestamp: string;
    extra_data: Record<string, unknown>;
    links: Record<string, Link>;
}
export interface RemoteComparison {
    id: string;
    kind: 'remote';
    server: string;
    requestId: number;
    username: string;
    review: ReviewResource;
    repositoryName: string;
    selected: DiffVersion;
    versions: DiffVersion[];
    files: RemoteFile[];
    reviewerDraft: ReviewerDraft | null;
    reviewerComments: ReviewComment[];
    details: DraftResource | ReviewResource;
    requestSnapshot: ReviewSnapshot | null;
    submissionMode?: DiffMode;
    patchHash?: string;
    activity?: PublicActivity;
    serverToken?: string;
}
export interface LineMap { rows: [number, number | null, number | null][]; }
export interface SourceRange { side: 'base' | 'head'; start: number; end: number; }
/** Resolve real rows from this exact filediff; never estimate an absent line. */
export function sourceRange(map: LineMap, first: number, count: number, preferred: 'base' | 'head' = 'head'): SourceRange | undefined {
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 1 || count < 1) { return; }
    const rows = map.rows.filter(row => row[0] >= first && row[0] < first + count);
    if (!rows.some(row => row[0] === first) || !rows.some(row => row[0] === first + count - 1)) { return; }
    for (const side of [preferred, preferred === 'head' ? 'base' as const : 'head' as const]) {
        const lines = rows.flatMap(row => row[side === 'base' ? 1 : 2] == null ? [] : [row[side === 'base' ? 1 : 2]!]).filter(line => line > 0);
        if (lines.length) { return { side, start: lines.reduce((a, b) => Math.min(a, b)), end: lines.reduce((a, b) => Math.max(a, b)) }; }
    }
    return;
}
export interface InlineDraft {
    id: string;
    fileId: number;
    side: 'base' | 'head';
    firstLine: number; // Review Board virtual diff row, NOT source/destination line.
    numLines: number;
    text: string;
    issueOpened: boolean;
}
export interface ReviewFeedback {
    body: string;
    shipIt: boolean;
    comments: InlineDraft[];
}
export interface ReviewWrite {
    operationId: string;
    kind: 'save' | 'publish';
    comparison: RemoteComparison;
    feedback: ReviewFeedback;
    reviewId?: number;
}
export interface FeedbackReceipt {
    id: number;
    requestId: number;
    server: string;
    published: boolean;
    fingerprint: string;
    operationId: string;
    diffId: number;
    revision: number;
}

export function diffPrefix(comparison: RemoteComparison): string {
    return `/review-requests/${comparison.requestId}/${comparison.selected.scope === 'draft' ? 'draft/' : ''}diffs/${comparison.selected.revision}/`;
}
export function draftRestriction(comparison: RemoteComparison): string {
    return comparison.reviewerComments.some(comment => !comparison.files.some(file => comment.links.filediff?.href.endsWith(`/files/${file.id}/`)))
        ? '服务器审阅草稿含其他差异版本的评论，请先在浏览器处理该草稿，再审阅当前版本。' : '';
}
export function virtualRange(map: LineMap, side: 'base' | 'head', start: number, end: number): { firstLine: number; numLines: number } {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) { throw new Error('无效评论行范围。'); }
    const column = side === 'base' ? 1 : 2;
    const selected = map.rows.filter(row => row[column] !== null && row[column]! >= start && row[column]! <= end);
    const lines = new Set(selected.map(row => row[column]));
    if (lines.size !== end - start + 1 || !selected.length) { throw new Error('服务器没有这些行的精确 diff 映射，无法安全添加行内评论。'); }
    const first = selected.reduce((value, row) => Math.min(value, row[0]), Infinity), last = selected.reduce((value, row) => Math.max(value, row[0]), 0);
    return { firstLine: first, numLines: last - first + 1 };
}
