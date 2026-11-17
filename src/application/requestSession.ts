import { randomUUID } from 'node:crypto';
import { ApiError, RBToolsAdapter } from '../adapters/rbtools';
import { RemoteComparison } from '../domain/comparison';
import { ReviewFields, ReviewSnapshot, validateFields, validatePublication } from '../domain/model';
import { assertBoundCommit, bindingKey, CommitBinding, fileSetHash, readBinding, ReviewSafetyError, ServerDiff } from '../domain/submission';
import { sameSnapshot } from '../domain/snapshot';

export type RequestMetadata = Pick<ReviewFields, 'summary' | 'description' | 'people' | 'groups' | 'bugs'>;
export interface RequestWrite {
    kind: 'metadata' | 'publish'; comparison: RemoteComparison; fields: ReviewFields; patchHash: string; operationId: string;
    binding?: CommitBinding;
}
export interface RequestStore { load(): RequestWrite | undefined; save(value: RequestWrite | undefined): Promise<void>; }
export interface RequestReceipt { id: number; server: string; published: boolean; applied: boolean; }

export function requestFields(snapshot: ReviewSnapshot): ReviewFields {
    const details = snapshot.draft ?? snapshot.review;
    return { summary: details.summary, description: details.description, people: details.target_people.map(item => item.title!),
        groups: details.target_groups.map(item => item.title!), bugs: details.bugs_closed, testing: details.testing_done,
        branch: details.branch, changeDescription: snapshot.draft?.changedescription ?? '' };
}
function equalFields(snapshot: ReviewSnapshot, fields: ReviewFields, published: boolean): boolean {
    const details = published ? snapshot.review : snapshot.draft;
    if (!details) { return false; }
    const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    return details.summary === fields.summary.trim() && details.description === fields.description && details.testing_done === fields.testing
        && details.branch === fields.branch && same(details.target_people.map(item => item.title!), fields.people)
        && same(details.target_groups.map(item => item.title!), fields.groups) && same(details.bugs_closed, fields.bugs);
}

/** Server-page lifecycle: independent of a local checkout or an upload plan. */
export class RequestSession {
    private writing = false;
    constructor(private readonly backend: (server: string) => RBToolsAdapter, readonly store: RequestStore) {}
    private idle(): void { if (this.writing || this.store.load()) { throw new Error('Check the previous request operation first.'); } }
    private async current(comparison: RemoteComparison, signal?: AbortSignal): Promise<ReviewSnapshot> {
        const backend = this.backend(comparison.server), snapshot = await backend.snapshot(comparison.requestId, signal);
        if (await backend.username(signal) !== comparison.username || snapshot.review.links.submitter?.title !== comparison.username) {
            throw new Error('Only the current author can edit this request.');
        }
        if (snapshot.review.status !== 'pending') { throw new Error('This request is closed.'); }
        if (!sameSnapshot(snapshot, comparison.requestSnapshot)) { throw new ReviewSafetyError('Request content changed. Refresh before continuing.'); }
        if (comparison.selected.revision !== Math.max(...comparison.versions.map(item => item.revision))) { throw new Error('Select the latest diff first.'); }
        return snapshot;
    }
    private async verifyDiff(write: RequestWrite, published: boolean, signal?: AbortSignal): Promise<void> {
        const comparison = write.comparison, scope = published ? 'published' : comparison.selected.scope;
        const backend = this.backend(comparison.server), prefix = `/review-requests/${comparison.requestId}/${scope === 'draft' ? 'draft/' : ''}diffs/`;
        const diffs = await backend.list<ServerDiff>(prefix, 'diffs', {}, signal);
        const diff = diffs.sort((a, b) => b.revision - a.revision)[0];
        if (diff?.id !== comparison.selected.id || await backend.patchHash(comparison.requestId, comparison.selected.revision, scope, signal) !== write.patchHash) {
            throw new Error('Server diff changed. Refresh this request.');
        }
        if (comparison.patchHash && comparison.patchHash !== write.patchHash) { throw new ReviewSafetyError('The diff changed since it was opened. Refresh before continuing.'); }
        if (write.binding) {
            const actual = readBinding(diff.extra_data?.[bindingKey]);
            if (!actual || Object.entries(write.binding).some(([key, value]) => actual[key as keyof CommitBinding] !== value) || write.patchHash !== actual.patchHash) {
                throw new ReviewSafetyError('The diff no longer matches its confirmed HEAD. Preview and save it again.');
            }
            const files = await backend.list<{ source_file: string; dest_file: string }>(`${prefix}${diff.revision}/files/`, 'files', {}, signal);
            if (fileSetHash(files.map(file => file.dest_file || file.source_file)) !== actual.filesHash) { throw new ReviewSafetyError('The bound file set changed. Check the server.'); }
        }
    }
    private async binding(comparison: RemoteComparison, snapshot: ReviewSnapshot, signal?: AbortSignal): Promise<CommitBinding | undefined> {
        if (snapshot.review.created_with_history) { return; }
        const backend = this.backend(comparison.server), selected = comparison.selected;
        const prefix = `/review-requests/${comparison.requestId}/${selected.scope === 'draft' ? 'draft/' : ''}diffs/`;
        const diff = (await backend.api<{ diff: ServerDiff }>(`${prefix}${selected.revision}/`, {}, signal)).diff;
        const binding = readBinding(diff.extra_data?.[bindingKey]);
        if (!binding) {
            const version = snapshot.draft?.extra_data.rbtflow_binding_version;
            if (version === '1' || version === 1) { throw new ReviewSafetyError('This draft has no confirmed HEAD binding. Check the server.'); }
            // An external diff upload must not inherit the old public commit ID.
            if (selected.scope === 'draft' && snapshot.review.public) {
                const published = await backend.list<ServerDiff>(`/review-requests/${comparison.requestId}/diffs/`, 'diffs', {}, signal);
                const previous = published.sort((a, b) => b.revision - a.revision)[0];
                if (readBinding(previous?.extra_data?.[bindingKey])) { throw new ReviewSafetyError('The new diff has no HEAD binding. Preview and save it with RBTFlow.'); }
            }
            return;
        }
        backend.assertRepository(snapshot.review, binding.repositoryId);
        assertBoundCommit(binding, snapshot.draft ?? snapshot.review, diff);
        return binding;
    }
    private async result(write: RequestWrite, signal?: AbortSignal): Promise<RequestReceipt> {
        const backend = this.backend(write.comparison.server), snapshot = await backend.snapshot(write.comparison.requestId, signal);
        const published = write.kind === 'publish';
        if (!equalFields(snapshot, write.fields, published) || (published && (!snapshot.review.public || snapshot.draft))) {
            throw new Error('Request result does not match. Check the server.');
        }
        if (!published && snapshot.draft?.extra_data.rbtflow_request_operation_id !== write.operationId) { throw new Error('Draft operation marker changed. Check the server.'); }
        if (write.binding) {
            this.backend(write.comparison.server).assertRepository(snapshot.review, write.binding.repositoryId);
            assertBoundCommit(write.binding, published ? snapshot.review : snapshot.draft!, { id: write.binding.diffId, revision: write.binding.revision, extra_data: {} });
        }
        await this.verifyDiff(write, published, signal);
        if ((await backend.snapshot(write.comparison.requestId, signal)).fingerprint !== snapshot.fingerprint) { throw new ReviewSafetyError('The request changed during verification. Check the server.'); }
        return { id: write.comparison.requestId, server: write.comparison.server, published, applied: true };
    }
    private async rejected(error: unknown, write: RequestWrite, signal?: AbortSignal): Promise<never> {
        if (error instanceof ApiError && (error.notApplied || sameSnapshot(await this.backend(write.comparison.server).snapshot(write.comparison.requestId, signal), write.comparison.requestSnapshot))) {
            await this.store.save(undefined);
        }
        throw error;
    }
    async edit(comparison: RemoteComparison, changes: Partial<RequestMetadata>, signal?: AbortSignal): Promise<RequestReceipt> {
        this.idle(); this.writing = true;
        try {
            const snapshot = await this.current(comparison, signal), fields = { ...requestFields(snapshot), ...structuredClone(changes) };
            validateFields(fields);
            const backend = this.backend(comparison.server); await backend.validatePeople(fields, signal);
            const write: RequestWrite = { kind: 'metadata', comparison: structuredClone(comparison), fields,
                patchHash: await backend.patchHash(comparison.requestId, comparison.selected.revision, comparison.selected.scope, signal), operationId: randomUUID(),
                binding: await this.binding(comparison, snapshot, signal) };
            await this.verifyDiff(write, false, signal);
            await this.store.save(write);
            try {
                await backend.editRequest(comparison.requestId, { request_updated: snapshot.review.last_updated,
                    draft_updated: snapshot.draft?.last_updated ?? null, operation_id: write.operationId,
                    fields: { summary: fields.summary.trim(), description: fields.description, target_people: fields.people.join(','),
                        target_groups: fields.groups.join(','), bugs_closed: fields.bugs.join(',') } }, signal);
            } catch (error) { return await this.rejected(error, write, signal); }
            const receipt = await this.result(write, signal); await this.store.save(undefined); return receipt;
        } finally { this.writing = false; }
    }
    async publish(comparison: RemoteComparison, signal?: AbortSignal): Promise<RequestReceipt> {
        this.idle(); this.writing = true;
        try {
            const snapshot = await this.current(comparison, signal);
            if (!snapshot.draft) { throw new Error('No request draft to publish.'); }
            const binding = await this.binding(comparison, snapshot, signal);
            const fields = requestFields(snapshot); validatePublication(fields); validateFields(fields);
            const backend = this.backend(comparison.server); await backend.validatePeople(fields, signal);
            const write: RequestWrite = { kind: 'publish', comparison: structuredClone(comparison), fields,
                patchHash: await backend.patchHash(comparison.requestId, comparison.selected.revision, comparison.selected.scope, signal), operationId: randomUUID(),
                binding };
            await this.verifyDiff(write, false, signal);
            await this.store.save(write);
            try { await backend.publish(comparison.requestId, signal); }
            catch (error) { return await this.rejected(error, write, signal); }
            const receipt = await this.result(write, signal); await this.store.save(undefined); return receipt;
        } finally { this.writing = false; }
    }
    async reconcile(signal?: AbortSignal): Promise<RequestReceipt | undefined> {
        if (this.writing) { throw new Error('Request operation in progress.'); }
        const write = this.store.load(); if (!write) { return; }
        this.writing = true;
        try {
            const backend = this.backend(write.comparison.server);
            if (await backend.username(signal) !== write.comparison.username) { throw new Error('Sign in as the original author first.'); }
            const snapshot = await backend.snapshot(write.comparison.requestId, signal);
            if (sameSnapshot(snapshot, write.comparison.requestSnapshot)) {
                await this.store.save(undefined);
                return { id: write.comparison.requestId, server: write.comparison.server, published: false, applied: false };
            }
            const receipt = await this.result(write, signal); await this.store.save(undefined); return receipt;
        } finally { this.writing = false; }
    }
}
