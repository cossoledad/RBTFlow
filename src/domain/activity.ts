import { digest, DraftResource, ReviewResource } from './model';
import { DiffVersion, RemoteComparison, ReviewComment, ReviewerDraft } from './comparison';
import { snapshotFingerprint } from './snapshot';

export interface PublicActivity { id: number; type: string; timestamp: string; actor: string; }
export interface SelectedProbe {
    review: ReviewResource; draft: DraftResource | null; versions: DiffVersion[];
    reviewerDraft: ReviewerDraft | null; reviewerComments: ReviewComment[]; activity?: PublicActivity;
}
export interface WatchResult { username: string; updates: PublicActivity[]; errors: { id: number; code: number; message: string }[]; selected?: SelectedProbe; }
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) { return value.map(canonical); }
    if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])); }
    return value;
}
export function counters(review: ReviewResource): unknown {
    const raw = review as unknown as Record<string, unknown>;
    return ['ship_it_count', 'issue_open_count', 'issue_resolved_count', 'issue_dropped_count', 'issue_verifying_count', 'approved', 'approval_failure']
        .map(key => raw[key] ?? null);
}
export function activityToken(review: ReviewResource, activity?: PublicActivity): string {
    return digest(JSON.stringify([activity?.type, activity?.timestamp, activity?.actor, counters(review)]));
}
export function eventStamp(activity?: PublicActivity): string { return JSON.stringify([activity?.type, activity?.timestamp, activity?.actor]); }
export function probeToken(probe: SelectedProbe): string {
    return digest(JSON.stringify(canonical({ content: snapshotFingerprint({ review: probe.review, draft: probe.draft }),
        versions: probe.versions.map(version => [version.scope, version.id, version.revision]).sort(),
        reviewerDraft: probe.reviewerDraft, reviewerComments: probe.reviewerComments, activity: activityToken(probe.review, probe.activity) })));
}
export function comparisonToken(comparison: RemoteComparison): string {
    return probeToken({ review: comparison.review, draft: comparison.requestSnapshot?.draft ?? null, versions: comparison.versions,
        reviewerDraft: comparison.reviewerDraft, reviewerComments: comparison.reviewerComments, activity: comparison.activity });
}
