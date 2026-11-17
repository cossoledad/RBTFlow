import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sameSnapshot, snapshotFingerprint } from '../domain/snapshot';
import { ReviewSnapshot } from '../domain/model';
import { comparisonToken, probeToken } from '../domain/activity';
import { RemoteComparison } from '../domain/comparison';

function snapshot(): ReviewSnapshot {
    const review = { id: 5, public: false, status: 'pending', created_with_history: false, last_updated: 'now', summary: 'Title', description: 'Body',
        testing_done: '', branch: 'main', bugs_closed: ['B', 'A'], extra_data: {}, commit_id: 'a'.repeat(40), target_groups: [],
        target_people: [{ href: 'https://example.test/api/users/alice/', title: 'alice' }],
        links: { submitter: { href: 'https://example.test/api/users/alice/', title: 'alice' }, repository: { href: 'https://example.test/api/repositories/1/' } } };
    return { review, draft: { ...structuredClone(review), changedescription: '' }, fingerprint: 'legacy-raw-hash' };
}
test('semantic snapshots tolerate read caches, computed counters and link labels while protecting actual edits and old journals', () => {
    const before = snapshot(), after = structuredClone(before);
    after.review.extra_data.calculated_trophies = true;
    Object.assign(after.review, { ship_it_count: 3, issue_open_count: 1, approved: false, approval_failure: 'Waiting' });
    after.review.links.submitter!.title = 'Renamed'; after.review.links.self = { href: 'https://example.test/api/5/' };
    after.draft!.target_people[0]!.title = 'Display label'; after.draft!.bugs_closed.reverse();
    after.fingerprint = snapshotFingerprint(after);
    assert(sameSnapshot(before, after));
    for (const field of ['summary', 'description', 'last_updated', 'commit_id', 'branch', 'status'] as const) {
        const changed = structuredClone(after); Object.assign(changed.review, { [field]: 'different' });
        assert(!sameSnapshot(before, changed), field);
    }
    const unknown = structuredClone(after); unknown.draft!.extra_data.company_policy = 'new'; assert(!sameSnapshot(before, unknown));
    const reviewer = structuredClone(after); reviewer.draft!.target_people[0]!.href = 'https://example.test/api/users/bob/'; assert(!sameSnapshot(before, reviewer));
});
test('selected request tokens detect public activity, issue state, private review drafts and new versions', () => {
    const s = snapshot(), comparison = { review: s.review, requestSnapshot: s, versions: [{ id: 4, revision: 1, scope: 'draft' }],
        reviewerDraft: null, reviewerComments: [], activity: undefined } as unknown as RemoteComparison;
    const probe = { review: s.review, draft: s.draft, versions: comparison.versions, reviewerDraft: null, reviewerComments: [] };
    assert.equal(comparisonToken(comparison), probeToken(probe));
    const original = probeToken(probe);
    for (const changed of [
        { ...probe, activity: { id: 5, actor: 'bob', type: 'reply', timestamp: 'later' } },
        { ...probe, review: Object.assign(structuredClone(probe.review), { issue_resolved_count: 1 }) },
        { ...probe, versions: [...probe.versions, { id: 9, revision: 2, scope: 'published' as const }] },
        { ...probe, draft: { ...probe.draft!, description: 'External edit' } },
    ]) { assert.notEqual(probeToken(changed), original); }
});
