import { randomUUID } from 'node:crypto';
import { ApiError, RBToolsAdapter } from '../adapters/rbtools';
import { RemoteComparison } from '../domain/comparison';
import { ReviewFields, ReviewSnapshot, validateFields, validatePublication } from '../domain/model';

export type RequestMetadata = Pick<ReviewFields, 'summary' | 'description' | 'people' | 'groups' | 'bugs'>;
export interface RequestWrite {
    kind: 'metadata' | 'publish'; comparison: RemoteComparison; fields: ReviewFields; patchHash: string; operationId: string;
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
        if (!comparison.requestSnapshot || snapshot.fingerprint !== comparison.requestSnapshot.fingerprint) { throw new Error('Request changed. Refresh before continuing.'); }
        if (comparison.selected.revision !== Math.max(...comparison.versions.map(item => item.revision))) { throw new Error('Select the latest diff first.'); }
        return snapshot;
    }
    private async verifyDiff(write: RequestWrite, published: boolean, signal?: AbortSignal): Promise<void> {
        const comparison = write.comparison, scope = published ? 'published' : comparison.selected.scope;
        const backend = this.backend(comparison.server), prefix = `/review-requests/${comparison.requestId}/${scope === 'draft' ? 'draft/' : ''}diffs/`;
        const diffs = await backend.list<{ id: number; revision: number }>(prefix, 'diffs', {}, signal);
        const diff = diffs.find(item => item.revision === comparison.selected.revision);
        if (diff?.id !== comparison.selected.id || await backend.patchHash(comparison.requestId, comparison.selected.revision, scope, signal) !== write.patchHash) {
            throw new Error('Server diff changed. Refresh this request.');
        }
    }
    private async result(write: RequestWrite, signal?: AbortSignal): Promise<RequestReceipt> {
        const backend = this.backend(write.comparison.server), snapshot = await backend.snapshot(write.comparison.requestId, signal);
        const published = write.kind === 'publish';
        if (!equalFields(snapshot, write.fields, published) || (published && (!snapshot.review.public || snapshot.draft))) {
            throw new Error('Request result does not match. Check the server.');
        }
        if (!published && snapshot.draft?.extra_data.rbtflow_request_operation_id !== write.operationId) { throw new Error('Draft operation marker changed. Check the server.'); }
        await this.verifyDiff(write, published, signal);
        return { id: write.comparison.requestId, server: write.comparison.server, published, applied: true };
    }
    private async rejected(error: unknown, write: RequestWrite, signal?: AbortSignal): Promise<never> {
        if (error instanceof ApiError && (error.notApplied || (await this.backend(write.comparison.server).snapshot(write.comparison.requestId, signal)).fingerprint === write.comparison.requestSnapshot?.fingerprint)) {
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
                patchHash: await backend.patchHash(comparison.requestId, comparison.selected.revision, comparison.selected.scope, signal), operationId: randomUUID() };
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
            const fields = requestFields(snapshot); validatePublication(fields); validateFields(fields);
            const backend = this.backend(comparison.server); await backend.validatePeople(fields, signal);
            const write: RequestWrite = { kind: 'publish', comparison: structuredClone(comparison), fields,
                patchHash: await backend.patchHash(comparison.requestId, comparison.selected.revision, comparison.selected.scope, signal), operationId: randomUUID() };
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
            if (snapshot.fingerprint === write.comparison.requestSnapshot?.fingerprint) {
                await this.store.save(undefined);
                return { id: write.comparison.requestId, server: write.comparison.server, published: false, applied: false };
            }
            const receipt = await this.result(write, signal); await this.store.save(undefined); return receipt;
        } finally { this.writing = false; }
    }
}
