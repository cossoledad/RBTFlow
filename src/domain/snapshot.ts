import { digest, DraftResource, ReviewResource, ReviewSnapshot } from './model';

// These are computed/read-only API fields, not edits to a request or draft.
const computed = new Set(['approved', 'approval_failure', 'ship_it_count', 'issue_open_count', 'issue_resolved_count',
    'issue_dropped_count', 'issue_verifying_count', 'absolute_url', 'url']);
const unordered = new Set(['target_people', 'target_groups', 'bugs_closed', 'depends_on', 'blocks']);
function stable(value: unknown): unknown {
    if (Array.isArray(value)) { return value.map(stable); }
    if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])); }
    return value;
}
function link(value: unknown): unknown {
    const href = (value as { href?: string } | null)?.href;
    return href ? new URL(href).pathname : value;
}
function content(resource: ReviewResource | DraftResource): unknown {
    const fields = Object.fromEntries(Object.entries(resource).filter(([key]) => !computed.has(key)));
    // Visiting the HTML page lazily adds this cache flag (Review Board TrophyManager).
    fields.extra_data = Object.fromEntries(Object.entries(resource.extra_data).filter(([key]) => key !== 'calculated_trophies'));
    fields.links = Object.fromEntries(Object.entries(resource.links).filter(([key]) => ['repository', 'submitter', 'latest_diff'].includes(key)).map(([key, value]) => [key, link(value)]));
    for (const key of unordered) {
        const values = fields[key];
        if (Array.isArray(values)) { fields[key] = values.map(value => typeof value === 'object' ? link(value) : value).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); }
    }
    // Keep last_updated: it also guards related draft attachments not embedded in this API response.
    return stable(fields);
}
export function snapshotFingerprint(snapshot: Pick<ReviewSnapshot, 'review' | 'draft'>): string {
    return digest(JSON.stringify({ review: content(snapshot.review), draft: snapshot.draft ? content(snapshot.draft) : null }));
}
/** Recompute both sides so journals written by older versions remain valid. */
export function sameSnapshot(a: ReviewSnapshot | null | undefined, b: ReviewSnapshot | null | undefined): boolean {
    return !!a && !!b && snapshotFingerprint(a) === snapshotFingerprint(b);
}
