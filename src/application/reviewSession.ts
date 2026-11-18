import { randomUUID } from 'node:crypto';
import { GitAdapter } from '../adapters/git';
import { ApiError, Connection, RBToolsAdapter } from '../adapters/rbtools';
import { CommitConflict, inputKey, patchContentDigest, patchDigest, PendingWrite, Receipt, ReviewFields, ReviewInput, ReviewPlan, ReviewSnapshot, validateFields, validatePublication } from '../domain/model';
import { CommitConflictError, PatchMismatchError, ReviewSafetyError, ServerDiff } from '../domain/submission';
import { sameSnapshot } from '../domain/snapshot';

export interface PendingStore {
    load(): PendingWrite | undefined;
    save(value: PendingWrite | undefined): Promise<void>;
    loadConflict?(): CommitConflict | undefined;
    saveConflict?(value: CommitConflict | undefined): Promise<void>;
}
export type BackendFactory = (server: string) => RBToolsAdapter;

function remoteKey(value: string): string {
    return value.replace(/^git@([^:]+):/, 'ssh://git@$1/').replace(/\.git\/?$/, '').replace(/\/$/, '');
}

/** A session belongs to one worktree. Writes have an on-disk uncertainty record. */
export class ReviewSession {
    plan?: ReviewPlan;
    patch?: Buffer;
    receipt?: Receipt;
    private generation = 0;
    private writing = false;
    private lastConflict?: CommitConflict;
    constructor(readonly root: string, readonly git: GitAdapter, readonly backend: BackendFactory, readonly pendingStore: PendingStore) {}
    get pending(): PendingWrite | undefined { return this.pendingStore.load(); }
    get conflict(): CommitConflict | undefined {
        const pending = this.pending;
        if (pending) { return pending.commitConflict; }
        return this.plan?.bindingVersion && this.sameCommit(this.lastConflict, this.plan) ? this.lastConflict : undefined;
    }
    private sameCommit(conflict: CommitConflict | undefined, plan: ReviewPlan): boolean {
        return !!conflict && conflict.head === plan.git.head && conflict.repositoryId === plan.repository.id
            && conflict.server === plan.server && conflict.username === plan.username;
    }
    private async lookupConflict(plan: ReviewPlan, excludeId?: number, signal?: AbortSignal, scanDrafts = true): Promise<CommitConflict | undefined> {
        if (!plan.bindingVersion) { return; }
        const requests = await this.backend(plan.server).commitRequests(plan, excludeId ?? plan.input.reviewId ?? 0, signal, scanDrafts);
        const previous = this.pending?.commitConflict ?? this.pendingStore.loadConflict?.() ?? this.lastConflict;
        // An empty public query cannot disprove a known 227 with an invisible owner.
        const selfOwnsHead = plan.previous && (plan.previous.draft?.commit_id === plan.git.head || plan.previous.review.commit_id === plan.git.head);
        const conflict = requests.length ? { head: plan.git.head, repositoryId: plan.repository.id, server: plan.server, username: plan.username, requests }
            : !selfOwnsHead && this.sameCommit(previous, plan) && (!previous!.requests.length
                || !scanDrafts && previous!.requests.some(request => !request.public)) ? previous : undefined;
        this.lastConflict = conflict;
        if (conflict || this.sameCommit(previous, plan)) { await this.pendingStore.saveConflict?.(conflict); }
        return conflict;
    }
    /** Read-only migration/classification for drafts uploaded before conflict recovery existed. */
    async inspectConflict(signal?: AbortSignal): Promise<CommitConflict | undefined> {
        const pending = this.pending;
        if (pending?.kind !== 'post' || !pending.plan.bindingVersion || !pending.id) { return; }
        const backend = this.backend(pending.plan.server);
        if (await backend.username(signal) !== pending.plan.username) { throw new ReviewSafetyError('Sign in as the original author.'); }
        const snapshot = await backend.snapshot(pending.id, signal);
        return this.inspectPendingConflict(pending, snapshot, signal);
    }
    private async inspectPendingConflict(pending: PendingWrite, snapshot: ReviewSnapshot, signal?: AbortSignal): Promise<CommitConflict | undefined> {
        if (pending.kind !== 'post' || !pending.plan.bindingVersion || !pending.id || pending.patchMismatch) { return; }
        const bound = (snapshot.draft ?? snapshot.review).commit_id === pending.plan.git.head;
        const conflict = bound ? undefined : await this.lookupConflict(pending.plan, pending.id, signal);
        if (bound && this.sameCommit(this.pendingStore.loadConflict?.() ?? this.lastConflict, pending.plan)) {
            this.lastConflict = undefined; await this.pendingStore.saveConflict?.(undefined);
        }
        if (conflict || pending.commitConflict) {
            pending.commitConflict = conflict; await this.pendingStore.save(pending);
        }
        return conflict;
    }
    private async syncBinding(pending: PendingWrite, signal?: AbortSignal, verifiedDiff?: ServerDiff): Promise<void> {
        try { await this.backend(pending.plan.server).replaceFields(pending.plan, pending.fields, pending.id!, signal, pending.bindingCheckpoint, verifiedDiff); }
        catch (error) {
            if (!(error instanceof ApiError && error.code === 227 && pending.plan.bindingVersion)) { throw error; }
            this.backend(pending.plan.server).options.log?.(`Commit binding rejected (API 227) for draft #${pending.id}: ${error.message}`);
            let requests: CommitConflict['requests'] = [];
            try { requests = await this.backend(pending.plan.server).commitRequests(pending.plan, pending.id!, signal); }
            catch (lookupError) { this.backend(pending.plan.server).options.log?.(`Commit conflict lookup failed: ${String(lookupError)}`); }
            pending.commitConflict = { server: pending.plan.server, username: pending.plan.username, repositoryId: pending.plan.repository.id, head: pending.plan.git.head, requests };
            this.lastConflict = pending.commitConflict;
            await this.pendingStore.save(pending); await this.pendingStore.saveConflict?.(pending.commitConflict);
            throw new CommitConflictError(pending.commitConflict, pending.id);
        }
    }
    invalidate(): void { this.generation++; this.plan = undefined; this.patch = undefined; }
    private assertIdle(): void { if (this.writing) { throw new Error('审核操作正在进行，请等待或取消。'); } }
    async connect(server: string, signal?: AbortSignal): Promise<Connection> { return this.backend(server).connect(signal); }
    async preview(input: ReviewInput, signal?: AbortSignal): Promise<ReviewPlan> {
        this.assertIdle();
        this.invalidate();
        const generation = this.generation;
        // Inspect the DAG before deciding whether the explicitly selected transport is compatible.
        const git = await this.git.analyze(this.root, { ...input, mode: 'squash' }, signal);
        const backend = this.backend(input.server);
        const connection = await backend.connect(signal);
        let repository = connection.repositories.find(repo => repo.id === input.repositoryId);
        if (!repository && input.repositoryId === null && connection.defaultRepository) {
            repository = connection.repositories.find(repo => repo.name === connection.defaultRepository);
        }
        if (!repository && input.repositoryId === null) {
            const remotes = (await this.git.remotes(this.root, signal)).map(remoteKey);
            const matches = connection.repositories.filter(repo => [repo.path, repo.mirror_path].some(url => url && remotes.includes(remoteKey(url))));
            if (matches.length === 1) { repository = matches[0]; }
        }
        if (!repository) { throw new Error('请先连接服务器并明确选择对应的服务器 Git 仓库。'); }
        const previous = input.reviewId ? await backend.snapshot(input.reviewId, signal) : null;
        const mode = previous?.review.created_with_history ? 'history' : input.mode;
        if (previous && !previous.review.created_with_history && mode === 'history') { throw new ReviewSafetyError('This request uses final diffs. Create a new request for commit history.'); }
        if (previous && mode === 'squash' && await backend.requestMode(previous, signal) === 'bound') { throw new ReviewSafetyError('This request has a HEAD binding. Use Final diff + HEAD to update it.'); }
        if (mode === 'history' && (!connection.supportsHistory || !git.linear || git.emptyCommits)) {
            throw new ReviewSafetyError('This history request needs a linear branch. Create a new request for the final diff.');
        }
        if (previous) {
            backend.assertRepository(previous.review, repository.id);
            if (previous.review.status !== 'pending') { throw new Error('只能更新仍处于 pending 状态的审核单。'); }
            if (previous.review.links.submitter?.title !== connection.username) { throw new Error('当前只允许更新自己提交的审核单。'); }
        }
        const patch = await backend.diff(git, input, repository, signal);
        if (!patch.length) { throw new Error('RBTools 返回了空 diff。'); }
        if (connection.maxDiffSize > 0 && patch.length > connection.maxDiffSize) { throw new Error(`差异 ${patch.length} 字节超过服务器上限 ${connection.maxDiffSize} 字节。`); }
        if (signal?.aborted || generation !== this.generation) { throw new Error('预览已过期，请重新分析。'); }
        if (git.fingerprint !== await this.git.fingerprint(this.root, input, signal)) { throw new Error('Git 状态已变化，请重新预览。'); }
        const plan: ReviewPlan = { id: randomUUID(), input: { server: connection.server, repositoryId: repository.id,
            targetRef: input.targetRef, baseRef: input.baseRef, mode, reviewId: input.reviewId }, git,
            server: connection.server, repository, rbtVersion: connection.rbtVersion, serverVersion: connection.version,
            username: connection.username, patchHash: patchDigest(patch), patchContentHash: patchContentDigest(patch),
            previous, bindingVersion: mode === 'bound' ? 1 : undefined };
        try { await this.lookupConflict(plan, undefined, signal, false); }
        catch (error) {
            if (!(error instanceof ApiError) || error.code !== 114) { throw error; }
            backend.options.log?.('Commit lookup deferred because Review Board is rate limiting. Upload will check again.');
        }
        if (signal?.aborted || generation !== this.generation) { throw new Error('Preview changed. Preview again.'); }
        this.plan = plan; this.patch = patch; this.receipt = undefined;
        return plan;
    }
    private async current(planId: string, input: ReviewInput, signal?: AbortSignal): Promise<ReviewPlan> {
        const plan = this.plan;
        if (!plan || plan.id !== planId || inputKey(input) !== inputKey(plan.input)) { throw new Error('表单或审核范围已变化，请重新预览。'); }
        if (plan.git.fingerprint !== await this.git.fingerprint(this.root, input, signal)) {
            this.invalidate(); throw new Error('Git 分支、引用或工作区已变化，请重新预览。');
        }
        return plan;
    }
    async post(planId: string, input: ReviewInput, fields: ReviewFields, signal?: AbortSignal): Promise<Receipt> {
        this.assertIdle();
        if (this.pending) { throw new Error('上次操作的结果待确认，请先检查服务器状态。'); }
        this.writing = true;
        try {
            validateFields(fields);
            const plan = await this.current(planId, input, signal);
            fields = { ...fields, branch: plan.input.targetRef };
            const backend = this.backend(plan.server);
            if (await backend.username(signal) !== plan.username) { throw new Error('登录用户已变化，请重新连接并预览。'); }
            const conflict = await this.lookupConflict(plan, undefined, signal);
            if (conflict) { throw new CommitConflictError(conflict); }
            await backend.validatePeople(fields, signal);
            if (plan.previous && !sameSnapshot(await backend.snapshot(plan.previous.review.id, signal), plan.previous)) {
                throw new Error('审核单已被修改，请重新载入并预览，避免覆盖网页中的编辑。');
            }
            const patch = await backend.diff(plan.git, plan.input, plan.repository, signal);
            if (patchDigest(patch) !== plan.patchHash) { this.invalidate(); throw new Error('RBTools 差异已变化，请重新预览。'); }
            await this.current(planId, input, signal);
            const pending: PendingWrite = { kind: 'post', plan, fields, id: input.reviewId ?? undefined };
            await this.pendingStore.save(pending);
            const id = await backend.post(plan, fields, signal);
            pending.id = id;
            await this.pendingStore.save(pending);
            pending.bindingCheckpoint = await backend.snapshot(id, signal);
            await this.pendingStore.save(pending);
            let receipt: Receipt;
            try {
                const verifiedDiff = plan.patchContentHash ? await backend.verifyUploaded(plan, id, false, signal) : undefined;
                await this.syncBinding(pending, signal, verifiedDiff);
                pending.fieldsSynced = true;
                await this.pendingStore.save(pending);
                receipt = await backend.verify(plan, fields, id, false, signal);
            } catch (error) {
                await this.rememberPatchMismatch(pending, error);
                throw error;
            }
            const previous = await backend.snapshot(id, signal);
            if (previous.fingerprint !== receipt.fingerprint) { throw new ReviewSafetyError('The draft changed during verification. Check the server.'); }
            await this.pendingStore.save(undefined);
            this.receipt = receipt;
            // A saved draft is an existing review, even if the user originally chose new.
            this.plan = { ...plan, input: { ...plan.input, reviewId: id }, previous };
            return receipt;
        } finally { this.writing = false; }
    }
    async publish(planId: string, input: ReviewInput, fields: ReviewFields, signal?: AbortSignal): Promise<Receipt> {
        this.assertIdle();
        if (this.pending || !this.receipt || !this.plan) { throw new Error('请先保存并核对当前草稿。'); }
        this.writing = true;
        try {
            validatePublication(fields);
            const plan = await this.current(planId, input, signal), receipt = this.receipt, backend = this.backend(plan.server);
            if (plan.bindingVersion || plan.patchContentHash) { fields = { ...fields, branch: plan.input.targetRef }; }
            if (await backend.username(signal) !== plan.username) { throw new Error('登录用户已变化，请重新连接并预览。'); }
            if (input.reviewId !== receipt.id) { throw new Error('当前选择的审核单已变化，请重新预览。'); }
            const saved = await backend.verify(plan, fields, receipt.id, false, signal);
            if (saved.fingerprint !== receipt.fingerprint) { throw new Error('服务器草稿已变化，请重新载入核对后再发布。'); }
            await this.pendingStore.save({ kind: 'publish', plan, fields, id: receipt.id });
            try { await backend.publish(receipt.id, signal); }
            catch (error) {
                if (error instanceof ApiError && (await backend.snapshot(receipt.id, signal)).fingerprint === saved.fingerprint) {
                    await this.pendingStore.save(undefined);
                }
                throw error;
            }
            this.receipt = await backend.verify(plan, fields, receipt.id, true, signal);
            await this.pendingStore.save(undefined);
            this.invalidate();
            return this.receipt;
        } finally { this.writing = false; }
    }
    async reconcile(signal?: AbortSignal): Promise<Receipt | undefined> {
        this.assertIdle();
        const pending = this.pending;
        if (!pending) { return this.receipt; }
        if (pending.patchMismatch && pending.id) { throw new PatchMismatchError(pending.id); }
        this.writing = true;
        try {
            const backend = this.backend(pending.plan.server);
            if (await backend.username(signal) !== pending.plan.username) { throw new Error('Sign in as the original author to check this operation.'); }
            let id = pending.id;
            if (!id) {
                const reviews = await backend.list<{ id: number; public: boolean; extra_data: Record<string, unknown> }>('/review-requests/', 'review_requests', {
                    'from-user': pending.plan.username, repository: String(pending.plan.repository.id), status: 'all',
                }, signal);
                const matches = reviews.filter(review => review.extra_data.rbtflow_plan_id === pending.plan.id);
                // Unregistered custom fields live on the draft; Review Board does
                // not copy them to the public review resource when publishing.
                for (const review of reviews.filter(item => !item.public)) {
                    const snapshot = await backend.snapshot(review.id, signal);
                    if (snapshot.draft?.extra_data.rbtflow_plan_id === pending.plan.id && !matches.some(item => item.id === review.id)) { matches.push(review); }
                }
                if (matches.length > 1) { throw new Error('找到多个对应审核单，请到服务器核对后再继续。'); }
                id = matches[0]?.id;
            }
            if (!id) { throw new Error('暂未找到完整提交。请检查服务器上的新草稿；确认后可清除待确认状态，不会自动重发。'); }
            if (pending.id !== id) { pending.id = id; await this.pendingStore.save(pending); }
            const snapshot = await backend.snapshot(id, signal);
            const conflict = await this.inspectPendingConflict(pending, snapshot, signal);
            if (conflict) { throw new CommitConflictError(conflict, id); }
            // A rejected publication leaves the verified draft intact. It is a
            // known draft, not an indefinitely uncertain write.
            const published = pending.kind === 'publish' && !snapshot.draft && snapshot.review.public;
            let receipt: Receipt;
            try { receipt = await backend.verify(pending.plan, pending.fields, id, published, signal); }
            catch (error) {
                await this.rememberPatchMismatch(pending, error);
                if (pending.kind === 'post' && pending.plan.bindingVersion && !pending.bindingCheckpoint && snapshot.draft?.extra_data.rbtflow_plan_id === pending.plan.id) {
                    await backend.verifyUploaded(pending.plan, id, false, signal);
                    pending.bindingCheckpoint = snapshot; await this.pendingStore.save(pending);
                }
                throw error;
            }
            await this.pendingStore.save(undefined);
            this.receipt = receipt;
            this.invalidate();
            return receipt;
        } finally { this.writing = false; }
    }
    private async rememberPatchMismatch(pending: PendingWrite, error: unknown): Promise<void> {
        if (error instanceof PatchMismatchError && pending.kind === 'post' && !pending.patchMismatch) {
            pending.patchMismatch = true;
            await this.pendingStore.save(pending);
        }
    }
    /** Explicit recovery only: finish the same uploaded artifact, never post a second diff/request. */
    async completeBinding(signal?: AbortSignal): Promise<Receipt> {
        this.assertIdle(); const pending = this.pending;
        if (pending?.kind !== 'post' || !pending.plan.bindingVersion || !pending.id || !pending.bindingCheckpoint) { throw new ReviewSafetyError('Check the server before completing this draft.'); }
        if (pending.patchMismatch) { throw new PatchMismatchError(pending.id); }
        this.writing = true;
        try {
            const backend = this.backend(pending.plan.server);
            if (await backend.username(signal) !== pending.plan.username) { throw new ReviewSafetyError('Sign in as the original author.'); }
            const snapshot = await backend.snapshot(pending.id, signal);
            const conflict = await this.inspectPendingConflict(pending, snapshot, signal);
            if (conflict) { throw new CommitConflictError(conflict, pending.id); }
            const alreadySynced = pending.fieldsSynced || (snapshot.draft?.commit_id === pending.plan.git.head
                && snapshot.draft.extra_data.rbtflow_plan_id === pending.plan.id);
            if (alreadySynced) {
                // Read back our own write before comparing with the pre-write checkpoint.
                const receipt = await backend.verify(pending.plan, pending.fields, pending.id, false, signal);
                await this.pendingStore.save(undefined);
                this.receipt = receipt;
                this.invalidate();
                return receipt;
            }
            if (!sameSnapshot(snapshot, pending.bindingCheckpoint)) { throw new ReviewSafetyError('The draft changed since upload. Check the server before continuing.'); }
            const verifiedDiff = await backend.verifyUploaded(pending.plan, pending.id, false, signal);
            await this.syncBinding(pending, signal, verifiedDiff);
            pending.fieldsSynced = true;
            await this.pendingStore.save(pending);
            const receipt = await backend.verify(pending.plan, pending.fields, pending.id, false, signal);
            await this.pendingStore.save(undefined); this.receipt = receipt; this.invalidate(); return receipt;
        } catch (error) {
            await this.rememberPatchMismatch(pending, error);
            throw error;
        } finally { this.writing = false; }
    }
}
