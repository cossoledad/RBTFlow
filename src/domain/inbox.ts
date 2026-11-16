import { digest, ReviewResource } from './model';

export interface InboxIdentity { server: string; username: string; }
export interface InboxEntry {
    id: number; summary: string; author: string; repository: string; updatedAt: string;
    revision?: number; fingerprint: string; viaGroup: boolean;
}
export interface InboxState {
    identity: InboxIdentity; initialized: boolean; entries: InboxEntry[];
    read: Record<string, string[]>; announced: Record<string, string>; lastSync?: string;
}
export function inboxKey(identity: InboxIdentity): string { return digest(JSON.stringify([identity.server, identity.username])); }
export function emptyInbox(identity: InboxIdentity): InboxState { return { identity, initialized: false, entries: [], read: {}, announced: {} }; }
export function requestRevision(review: ReviewResource): number | undefined {
    const value = review.links.latest_diff?.href.match(/\/diffs\/(\d+)\/$/)?.[1]; return value ? Number(value) : undefined;
}
/** Content changes matter; activity timestamps alone must not re-alert on our own reviews. */
export function inboxFingerprint(review: ReviewResource): string {
    const links = (values: { href: string }[]) => values.map(value => new URL(value.href).pathname).sort();
    return digest(JSON.stringify({ id: review.id, summary: review.summary, description: review.description, testing: review.testing_done,
        branch: review.branch, bugs: [...review.bugs_closed].sort(), people: links(review.target_people), groups: links(review.target_groups),
        revision: requestRevision(review), repository: review.links.repository?.href && new URL(review.links.repository.href).pathname }));
}
export function inboxEntry(review: ReviewResource, viaGroup: boolean): InboxEntry {
    if (!Number.isSafeInteger(review.id) || review.id < 1) { throw new Error('Invalid request in inbox response.'); }
    return { id: review.id, summary: review.summary, author: review.links.submitter?.title ?? 'Unknown',
        repository: review.links.repository?.title ?? '', updatedAt: review.last_updated, revision: requestRevision(review),
        fingerprint: inboxFingerprint(review), viaGroup };
}
export function isUnread(state: InboxState, entry: InboxEntry): boolean { return !state.read[String(entry.id)]?.includes(entry.fingerprint); }
export function sortInbox(state: InboxState): InboxEntry[] {
    return [...state.entries].sort((a, b) => Number(isUnread(state, b)) - Number(isUnread(state, a)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id - a.id);
}
export function syncInbox(previous: InboxState, entries: InboxEntry[], now: string): { state: InboxState; arrivals: InboxEntry[] } {
    const state = structuredClone(previous), before = new Map(previous.entries.map(entry => [entry.id, entry.fingerprint]));
    state.entries = entries; state.initialized = true; state.lastSync = now;
    const arrivals = previous.initialized ? entries.filter(entry => before.get(entry.id) !== entry.fingerprint && previous.announced[String(entry.id)] !== entry.fingerprint && isUnread(state, entry)) : [];
    for (const entry of entries) { state.announced[String(entry.id)] = entry.fingerprint; }
    return { state, arrivals };
}
export function readInbox(previous: InboxState, observations: { id: number; fingerprint: string }[], read: boolean): InboxState {
    const state = structuredClone(previous);
    for (const entry of observations) {
        const key = String(entry.id), versions = state.read[key] ?? [];
        state.read[key] = read ? [...new Set([...versions, entry.fingerprint])].slice(-4) : versions.filter(value => value !== entry.fingerprint);
    }
    return state;
}
