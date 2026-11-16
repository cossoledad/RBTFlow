import { randomUUID } from 'node:crypto';
import { GitAdapter } from '../adapters/git';
import { ApiError, Connection, RBToolsAdapter } from '../adapters/rbtools';
import { inputKey, patchDigest, PendingWrite, Receipt, ReviewFields, ReviewInput, ReviewPlan, validateFields, validatePublication } from '../domain/model';

export interface PendingStore {
    load(): PendingWrite | undefined;
    save(value: PendingWrite | undefined): Promise<void>;
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
    constructor(readonly root: string, readonly git: GitAdapter, readonly backend: BackendFactory, readonly pendingStore: PendingStore) {}
    get pending(): PendingWrite | undefined { return this.pendingStore.load(); }
    invalidate(): void { this.generation++; this.plan = undefined; this.patch = undefined; }
    private assertIdle(): void { if (this.writing) { throw new Error('审核操作正在进行，请等待或取消。'); } }
    async connect(server: string, signal?: AbortSignal): Promise<Connection> { return this.backend(server).connect(signal); }
    async preview(input: ReviewInput, signal?: AbortSignal): Promise<ReviewPlan> {
        this.assertIdle();
        this.invalidate();
        const generation = this.generation;
        const git = await this.git.analyze(this.root, input, signal);
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
        if (input.mode === 'history' && !connection.supportsHistory) { throw new Error('该服务器不支持逐提交审核。'); }
        const previous = input.reviewId ? await backend.snapshot(input.reviewId, signal) : null;
        if (previous) {
            backend.assertRepository(previous.review, repository.id);
            if (previous.review.status !== 'pending') { throw new Error('只能更新仍处于 pending 状态的审核单。'); }
            if (previous.review.links.submitter?.title !== connection.username) { throw new Error('当前只允许更新自己提交的审核单。'); }
            if (previous.review.created_with_history !== (input.mode === 'history')) {
                throw new Error(`原审核单为${previous.review.created_with_history ? '逐提交历史' : '汇总 diff'}模式，不能直接转换；请选择相同模式或新建审核单。`);
            }
        }
        const patch = await backend.diff(git, input, repository, signal);
        if (!patch.length) { throw new Error('RBTools 返回了空 diff。'); }
        if (connection.maxDiffSize > 0 && patch.length > connection.maxDiffSize) { throw new Error(`差异 ${patch.length} 字节超过服务器上限 ${connection.maxDiffSize} 字节。`); }
        if (signal?.aborted || generation !== this.generation) { throw new Error('预览已过期，请重新分析。'); }
        if (git.fingerprint !== await this.git.fingerprint(this.root, input, signal)) { throw new Error('Git 状态已变化，请重新预览。'); }
        const plan: ReviewPlan = { id: randomUUID(), input: { server: connection.server, repositoryId: repository.id,
            targetRef: input.targetRef, baseRef: input.baseRef, mode: input.mode, reviewId: input.reviewId }, git,
            server: connection.server, repository, rbtVersion: connection.rbtVersion, serverVersion: connection.version,
            username: connection.username, patchHash: patchDigest(patch), previous };
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
            const backend = this.backend(plan.server);
            if (await backend.username(signal) !== plan.username) { throw new Error('登录用户已变化，请重新连接并预览。'); }
            await backend.validatePeople(fields, signal);
            if (plan.previous && (await backend.snapshot(plan.previous.review.id, signal)).fingerprint !== plan.previous.fingerprint) {
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
            await backend.replaceFields(plan, fields, id, signal);
            const receipt = await backend.verify(plan, fields, id, false, signal);
            const previous = await backend.snapshot(id, signal);
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
            const snapshot = await backend.snapshot(id, signal);
            // A rejected publication leaves the verified draft intact. It is a
            // known draft, not an indefinitely uncertain write.
            const published = pending.kind === 'publish' && !snapshot.draft && snapshot.review.public;
            const receipt = await backend.verify(pending.plan, pending.fields, id, published, signal);
            await this.pendingStore.save(undefined);
            this.receipt = receipt;
            this.invalidate();
            return receipt;
        } finally { this.writing = false; }
    }
}
