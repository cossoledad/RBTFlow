import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiError, RBToolsAdapter } from '../adapters/rbtools';
import { GitAdapter } from '../adapters/git';
import { PendingStore, ReviewSession } from '../application/reviewSession';
import { CommitConflict, patchDigest, PendingWrite, Receipt, ReviewPlan, ReviewSnapshot } from '../domain/model';
import { CommitConflictError, PatchMismatchError, ServerDiff } from '../domain/submission';
import { snapshotFingerprint } from '../domain/snapshot';
import { fields, input } from './helpers';

function fixture() {
    const server = 'http://reviews.example.test/', head = 'a'.repeat(40), patch = Buffer.from('review patch');
    let pending: PendingWrite | undefined, cached: CommitConflict | undefined;
    const journal: PendingStore = { load: () => structuredClone(pending), save: async value => { pending = structuredClone(value); },
        loadConflict: () => structuredClone(cached), saveConflict: async value => { cached = structuredClone(value); } };
    const plan = { id: 'plan', server, username: 'alice', input: { ...input, server }, repository: { id: 1, name: 'repo', path: 'repo', tool: 'Git' },
        git: { head, fingerprint: 'stable' }, patchHash: patchDigest(patch), previous: null, bindingVersion: 1 } as ReviewPlan;
    const review = { id: 2, summary: fields.summary, description: fields.description, testing_done: fields.testing, branch: fields.branch,
        target_people: [], target_groups: [], bugs_closed: [], status: 'pending', public: false, created_with_history: false, last_updated: 'now',
        commit_id: null, extra_data: {}, links: { submitter: { title: 'alice', href: server + 'api/users/alice/' }, repository: { href: server + 'api/repositories/1/' } } };
    const snapshot: ReviewSnapshot = { review, draft: { ...structuredClone(review), changedescription: '' }, fingerprint: '' };
    class Backend extends RBToolsAdapter {
        owners: CommitConflict['requests'] = []; uploads = 0; bindings = 0; fail = false; raceOwner = false; mismatch = false;
        constructor() { super('/unused', { executable: 'unused', storage: '/unused', server }); }
        override async username(): Promise<string> { return 'alice'; }
        override async validatePeople(): Promise<void> {}
        override async commitRequests(_plan: ReviewPlan, excludeId = 0): Promise<CommitConflict['requests']> { return this.owners.filter(owner => owner.id !== excludeId); }
        override async diff(): Promise<Buffer> { return patch; }
        override async post(): Promise<number> { this.uploads++; return 2; }
        override async snapshot(): Promise<ReviewSnapshot> { return { ...structuredClone(snapshot), fingerprint: snapshotFingerprint(snapshot) }; }
        override async replaceFields(current: ReviewPlan): Promise<void> {
            this.bindings++;
            if (this.fail) {
                if (this.raceOwner) { this.owners = [{ id: 1, author: 'alice', status: 'pending', public: true }]; }
                throw new ApiError('Commit ID already exists', 227);
            }
            snapshot.draft!.commit_id = current.git.head;
        }
        override async verifyUploaded(): Promise<ServerDiff> { return { id: 4, revision: 1, extra_data: {} }; }
        override async verify(): Promise<Receipt> {
            if (this.mismatch) { throw new PatchMismatchError(2); }
            return { id: 2, url: server + 'r/2/', diffRevision: 1, published: false,
                fingerprint: snapshotFingerprint(snapshot), verification: 'patch-and-metadata' };
        }
    }
    class Git extends GitAdapter { override async fingerprint(): Promise<string> { return 'stable'; } }
    const backend = new Backend(), create = () => new ReviewSession('/unused', new Git(), () => backend, journal);
    const session = create(); session.plan = plan;
    return { journal, plan, backend, session, create, snapshot };
}

test('commit ownership is checked before upload; an existing request cannot create a duplicate draft', async () => {
    const f = fixture(); f.backend.owners = [{ id: 1, author: 'alice', public: true, status: 'pending' }];
    await assert.rejects(f.session.post(f.plan.id, f.plan.input, fields), error => error instanceof CommitConflictError && error.conflict.requests[0]?.id === 1);
    assert.equal(f.backend.uploads, 0); assert.equal(f.backend.bindings, 0); assert.equal(f.session.pending, undefined);
    assert.equal(f.session.conflict?.requests[0]?.id, 1);
});

test('a legacy post-sync mismatch is classified before comparing the pre-sync checkpoint and can never rewrite the draft', async () => {
    const f = fixture(), checkpoint = await f.backend.snapshot();
    f.snapshot.draft!.commit_id = f.plan.git.head;
    f.snapshot.draft!.extra_data.rbtflow_plan_id = f.plan.id;
    await f.journal.save({ kind: 'post', plan: f.plan, fields, id: 2, bindingCheckpoint: checkpoint });
    f.backend.mismatch = true;
    await assert.rejects(f.session.completeBinding(), PatchMismatchError);
    assert.equal(f.session.pending?.patchMismatch, true);
    await assert.rejects(f.session.completeBinding(), PatchMismatchError);
    assert.equal(f.backend.bindings, 0); assert.equal(f.backend.uploads, 0);
});

test('a raced 227 persists a known conflict; check and complete never repeat the failed write across restart', async () => {
    const f = fixture(); f.backend.fail = true; f.backend.raceOwner = true;
    await assert.rejects(f.session.post(f.plan.id, f.plan.input, fields), CommitConflictError);
    assert.equal(f.session.pending?.id, 2); assert.equal(f.session.pending?.commitConflict?.requests[0]?.id, 1);
    assert.equal(f.backend.uploads, 1); assert.equal(f.backend.bindings, 1);
    const restarted = f.create();
    await assert.rejects(restarted.reconcile(), CommitConflictError);
    await assert.rejects(restarted.completeBinding(), CommitConflictError);
    assert.equal(f.backend.uploads, 1); assert.equal(f.backend.bindings, 1);
    const old = f.journal.load()!; delete old.commitConflict; await f.journal.save(old);
    assert.equal((await f.create().inspectConflict())?.requests[0]?.id, 1, 'Old pending journals migrate read-only');
});

test('invisible owners remain blocked after local release while a new HEAD can proceed', async () => {
    const f = fixture(); f.backend.fail = true;
    await assert.rejects(f.session.post(f.plan.id, f.plan.input, fields), CommitConflictError);
    assert.deepEqual(f.journal.loadConflict!()?.requests, []);
    await f.journal.save(undefined); // The UI archives the full pending record before releasing it.
    const restarted = f.create(); restarted.plan = f.plan;
    await assert.rejects(restarted.post(f.plan.id, f.plan.input, fields), CommitConflictError);
    assert.equal(f.backend.uploads, 1); assert.equal(f.backend.bindings, 1);
    f.backend.fail = false;
    const next = { ...f.plan, git: { ...f.plan.git, head: 'b'.repeat(40) } }; restarted.plan = next;
    await restarted.post(next.id, next.input, fields); assert.equal(f.backend.uploads, 2);
});

test('ownership released on the server and an externally completed binding can recover without stale conflict flags', async () => {
    const f = fixture(); f.backend.fail = true; f.backend.raceOwner = true;
    await assert.rejects(f.session.post(f.plan.id, f.plan.input, fields), CommitConflictError);
    f.backend.owners = []; f.backend.fail = false;
    assert.equal(await f.session.inspectConflict(), undefined); assert.equal(f.session.pending?.commitConflict, undefined);
    await f.session.completeBinding(); assert.equal(f.session.pending, undefined); assert.equal(f.backend.bindings, 2);
    const other = fixture(); other.backend.fail = true;
    await assert.rejects(other.session.post(other.plan.id, other.plan.input, fields), CommitConflictError);
    other.snapshot.draft!.commit_id = other.plan.git.head;
    await other.session.reconcile(); assert.equal(other.session.pending, undefined); assert.equal(other.backend.bindings, 1);
});
