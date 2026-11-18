import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
    CommitConflict, DiffMode, DraftResource, Receipt, ReviewFields, ReviewPlan, ReviewResource, ReviewSnapshot,
    ServerRepository, serverUrl,
} from '../domain/model';
import { ProcessError, runProcess } from './process';
import { diffPrefix, LineMap, RemoteComparison, ReviewerDraft, ReviewComment } from '../domain/comparison';
import { assertBoundCommit, bindingFor, bindingKey, CommitBinding, fileSetHash, fullCommitId, PatchMismatchError, readBinding, ReviewSafetyError, ServerDiff } from '../domain/submission';
import { snapshotFingerprint } from '../domain/snapshot';
import { PublicActivity, WatchResult } from '../domain/activity';

export class ApiError extends Error {
    constructor(message: string, readonly code: number, readonly notApplied = false, readonly brief?: string) { super(message); }
}
const rateLimits = new Map<string, number>();
const rateLimitError = () => new ApiError('Review Board API rate limit', 114, false, 'Review Board rate limit. Try again in a minute.');
export interface RbtOptions {
    executable: string;
    storage: string;
    server: string;
    timeoutMs?: number;
    token?: (server: string) => Promise<string | undefined>;
    log?: (message: string) => void;
}
interface ApiPayload { stat: string; err?: { code: number; msg: string }; total_results?: number; [key: string]: unknown; }
export interface Connection {
    server: string; username: string; version: string; supportsHistory: boolean;
    maxDiffSize: number; repositories: ServerRepository[]; rbtVersion: string;
    defaultRepository?: string;
}
export interface RepositoryContext {
    server: string;
    defaults: { server?: string; targetRef?: string; repository?: string; people?: string | string[]; groups?: string | string[]; branch?: string };
}

/** All API reads share RBTools authentication and trusted repository config. */
export class RBToolsAdapter {
    constructor(readonly root: string, readonly options: RbtOptions) {}
    async command(args: string[], signal?: AbortSignal, files: Record<string, string> = {}, trailing: string[] = []): Promise<Buffer> {
        const url = serverUrl(this.options.server);
        const rateKey = url ? new URL(url).origin : '';
        if ((rateLimits.get(rateKey) ?? 0) > Date.now() && args[0] !== '--version' && args[0] !== 'rbtflow-defaults') {
            throw rateLimitError();
        }
        const token = url ? await this.options.token?.(url) : undefined;
        const storage = path.join(this.options.storage, 'jobs');
        await mkdir(storage, { recursive: true, mode: 0o700 });
        const job = await mkdtemp(path.join(storage, 'rbt-'));
        await chmod(job, 0o700);
        const redact = (value: string) => token ? value.split(token).join('[REDACTED]') : value;
        try {
            const config = ['JSON_OUTPUT = False', 'DEBUG = False', 'OPEN_BROWSER = False',
                'WEB_LOGIN = False', 'PUBLISH = False', 'STAMP_WHEN_POSTING = False',
                'SUBMIT_AS = None', 'SQUASH_HISTORY = True', 'EXCLUDE_PATTERNS = []',
                'PARENT_BRANCH = None', 'MARKDOWN = False', 'DEPENDS_ON = []'];
            if (url) { config.push(`REVIEWBOARD_URL = ${JSON.stringify(url)}`); }
            if (token) { config.push(`API_TOKEN = ${JSON.stringify(token)}`, 'SAVE_COOKIES = False'); }
            await writeFile(path.join(job, '.reviewboardrc'), config.join('\n') + '\n', { mode: 0o600 });
            const expanded = [...args];
            for (const [flag, content] of Object.entries(files)) {
                const filename = path.join(job, flag.replace(/[^a-z]/g, '') + '.txt');
                await writeFile(filename, content, { mode: 0o600 });
                expanded.push(flag, filename);
            }
            expanded.push(...trailing);
            this.options.log?.(`rbt ${args[0]} · ${this.root}`);
            return await runProcess(this.options.executable, expanded, {
                cwd: this.root, signal, timeoutMs: this.options.timeoutMs,
                env: { ...process.env, NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1',
                    PYTHONPATH: [path.resolve(__dirname, '../../../python'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
                    RBTOOLS_CONFIG_PATH: [job, process.env.RBTOOLS_CONFIG_PATH].filter(Boolean).join(path.delimiter) },
            });
        } catch (error) {
            if (error instanceof ProcessError) {
                let message = error.message;
                if (error.reason === 'exit') {
                    let code: number | undefined;
                    try {
                        const payload = JSON.parse(error.stdout.toString('utf8')) as { errors?: string[]; err?: { code?: number } };
                        if (Array.isArray(payload.errors)) { message = payload.errors.join('\n'); }
                        code = payload.err?.code;
                    } catch { /* Raw CLI diagnostics remain available below. */ }
                    if (code === 114 || /API Error 114\b/.test(message + '\n' + error.stderr.toString('utf8'))) {
                        rateLimits.set(rateKey, Date.now() + 60_000);
                        throw rateLimitError();
                    }
                }
                const clean = new ProcessError(redact(message), Buffer.from(redact(error.stdout.toString('utf8'))),
                    Buffer.from(redact(error.stderr.toString('utf8'))), error.reason);
                this.options.log?.(`rbt ${args[0]}: ${clean.message}`);
                throw clean;
            }
            throw error;
        } finally { await rm(job, { recursive: true, force: true }); }
    }
    async api<T = ApiPayload>(resource: string, query: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
        if (!/^\/[a-zA-Z0-9_/%?.=&,-]*$/.test(resource) || resource.startsWith('//')) { throw new Error('无效的 API 路径。'); }
        const args = ['api-get', '--disable-cache', resource, ...Object.entries(query).map(([key, value]) => `--${key}=${value}`)];
        let bytes: Buffer;
        try { bytes = await this.command(args, signal); }
        catch (error) {
            if (error instanceof ProcessError && error.reason === 'exit') {
                let payload: ApiPayload | undefined;
                try { payload = JSON.parse(error.stdout.toString('utf8')) as ApiPayload; } catch { /* retain CLI diagnostics */ }
                if (payload?.err) { throw new ApiError(payload.err.msg, payload.err.code); }
            }
            throw error;
        }
        const payload = JSON.parse(bytes.toString('utf8')) as ApiPayload;
        if (payload.stat !== 'ok') { throw new ApiError(payload.err?.msg ?? 'API 返回异常。', payload.err?.code ?? -1); }
        return payload as T;
    }
    async list<T>(resource: string, key: string, query: Record<string, string> = {}, signal?: AbortSignal): Promise<T[]> {
        const items: T[] = [];
        while (true) {
            const result = await this.api<ApiPayload>(resource, { ...query, 'max-results': '200', start: String(items.length) }, signal);
            const page = result[key];
            if (!Array.isArray(page)) { throw new Error('服务器列表格式不正确。'); }
            items.push(...page as T[]);
            if (items.length >= (result.total_results ?? items.length)) { return items; }
            if (!page.length || items.length >= 10_000) { throw new Error('服务器列表过大或分页异常；请缩小查询范围。'); }
        }
    }
    async connect(signal?: AbortSignal): Promise<Connection> {
        const rbtVersion = (await this.command(['--version'], signal)).toString('utf8').trim();
        if (!/RBTools (?:[5-9]|[1-9]\d)\./.test(rbtVersion)) { throw new Error(`当前版本需 RBTools 5+，实际为 ${rbtVersion}`); }
        const info = await this.api<{ info: { product: { package_version: string }; site: { url: string };
            capabilities: { review_requests?: { supports_history?: boolean }; diffs?: { max_diff_size?: number } } } }>('/info/', {}, signal);
        const username = await this.username(signal);
        const context = await this.context(signal);
        const repositories = (await this.list<ServerRepository>('/repositories/', 'repositories', {}, signal)).filter(repo => repo.tool === 'Git');
        return { server: context.server, username,
            version: info.info.product.package_version, supportsHistory: !!info.info.capabilities.review_requests?.supports_history,
            maxDiffSize: info.info.capabilities.diffs?.max_diff_size ?? 0, repositories, rbtVersion, defaultRepository: context.defaults.repository };
    }
    async context(signal?: AbortSignal): Promise<RepositoryContext> {
        const data = JSON.parse((await this.command(['rbtflow-context', '--json', '--disable-cache'], signal)).toString('utf8')) as { server_url: string; defaults?: RepositoryContext['defaults'] };
        return { server: serverUrl(data.server_url), defaults: data.defaults ?? {} };
    }
    async repositoryDefaults(signal?: AbortSignal): Promise<RepositoryContext['defaults']> {
        const payload = JSON.parse((await this.command(['rbtflow-defaults', '--json'], signal)).toString('utf8')) as { defaults: RepositoryContext['defaults'] };
        return payload.defaults;
    }
    async guessMessage(message: Buffer, signal?: AbortSignal): Promise<{ summary?: string; description?: string; testing_done?: string; bugs_closed?: string }> {
        const payload = JSON.parse((await this.command(['rbtflow-guess-message', '--json'], signal,
            { '--message-file': message.toString('utf8') })).toString('utf8')) as { fields: { summary?: string; description?: string; testing_done?: string; bugs_closed?: string } };
        return payload.fields;
    }
    async editRequest(id: number, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
        const result = JSON.parse((await this.command(['rbtflow-edit-request', '--json', '--disable-cache'], signal,
            { '--fields-file': JSON.stringify(payload) }, [String(id)])).toString('utf8')) as { error?: { code: number; message: string }; not_applied?: boolean };
        if (result.error) { throw new ApiError(result.error.message, result.error.code, result.not_applied); }
    }
    async discardRequest(id: number, snapshot: ReviewSnapshot, author: string, signal?: AbortSignal): Promise<void> {
        const payload = {
            author, public: snapshot.review.public, request_updated: snapshot.review.last_updated,
            draft_updated: snapshot.draft?.last_updated ?? null, draft_id: snapshot.draft?.id ?? null,
        };
        const result = JSON.parse((await this.command(['rbtflow-discard-request', '--json', '--disable-cache'], signal,
            { '--fields-file': JSON.stringify(payload) }, [String(id)])).toString('utf8')) as {
                discarded?: boolean; error?: { code: number; message: string }; not_applied?: boolean;
            };
        if (result.error) { throw new ApiError(result.error.message, result.error.code, result.not_applied, result.error.code === 409 ? result.error.message : undefined); }
        if (!result.discarded) { throw new Error('Discard result is unknown. Check the server.'); }
    }
    async patchHash(id: number, revision: number, scope: 'draft' | 'published', signal?: AbortSignal, format?: CommitBinding['patchFormat']): Promise<string> {
        const result = JSON.parse((await this.command(['rbtflow-verify-patch', '--json', '--disable-cache',
            String(id), String(revision), scope], signal)).toString('utf8')) as { patch_hash: string; patch_content_hash: string };
        return format ? result.patch_content_hash : result.patch_hash;
    }
    async comparisonData(comparison: RemoteComparison, fileId: number, part: 'base' | 'head' | 'patch', signal?: AbortSignal): Promise<Buffer> {
        const payload = JSON.parse((await this.command(['rbtflow-read-comparison', '--json', '--disable-cache',
            String(comparison.requestId), String(comparison.selected.revision), comparison.selected.scope, String(fileId), part], signal)).toString('utf8')) as { content: string };
        return Buffer.from(payload.content, 'base64');
    }
    async lines(comparison: RemoteComparison, fileId: number, signal?: AbortSignal): Promise<LineMap> {
        return JSON.parse((await this.command(['rbtflow-read-comparison', '--json', '--disable-cache',
            String(comparison.requestId), String(comparison.selected.revision), comparison.selected.scope, String(fileId), 'lines'], signal)).toString('utf8')) as LineMap;
    }
    async fileComments(comparison: RemoteComparison, fileId: number, signal?: AbortSignal): Promise<ReviewComment[]> {
        return this.list<ReviewComment>(`${diffPrefix(comparison)}files/${fileId}/diff-comments/`, 'diff_comments', {}, signal);
    }
    async reviewerDraft(requestId: number, signal?: AbortSignal): Promise<ReviewerDraft | null> {
        try { return (await this.api<{ review: ReviewerDraft }>(`/review-requests/${requestId}/reviews/draft/`, {}, signal)).review; }
        catch (error) { if (error instanceof ApiError && error.code === 100) { return null; } throw error; }
    }
    async writeReview(requestId: number, payload: Record<string, unknown>, signal?: AbortSignal): Promise<number> {
        const result = JSON.parse((await this.command(['rbtflow-save-review', '--json', '--disable-cache'], signal,
            { '--fields-file': JSON.stringify(payload) }, [String(requestId)])).toString('utf8')) as { review_id: number };
        if (!Number.isSafeInteger(result.review_id)) { throw new Error('未取得有效审阅 ID，请核对服务器。'); }
        return result.review_id;
    }
    async username(signal?: AbortSignal): Promise<string> {
        const session = await this.api<{ session: { authenticated: boolean; links: { user?: { title: string } } } }>('/session/', {}, signal);
        if (!session.session.authenticated || !session.session.links.user?.title) {
            throw new Error('尚未登录 Review Board。请先在该项目运行 rbt login，或设置 API Token。');
        }
        return session.session.links.user.title;
    }
    async snapshot(id: number, signal?: AbortSignal): Promise<ReviewSnapshot> {
        const review = (await this.api<{ review_request: ReviewResource }>(`/review-requests/${id}/`, {}, signal)).review_request;
        let draft: DraftResource | null = null;
        try { draft = (await this.api<{ draft: DraftResource }>(`/review-requests/${id}/draft/`, {}, signal)).draft; }
        catch (error) { if (!(error instanceof ApiError && error.code === 100)) { throw error; } }
        return { review, draft, fingerprint: snapshotFingerprint({ review, draft }) };
    }
    async requestMode(snapshot: ReviewSnapshot, signal?: AbortSignal): Promise<DiffMode> {
        if (snapshot.review.created_with_history) { return 'history'; }
        const marker = snapshot.draft?.extra_data.rbtflow_binding_version;
        if (marker === 1 || marker === '1') { return 'bound'; }
        const diffs = await this.list<ServerDiff>(`/review-requests/${snapshot.review.id}/diffs/`, 'diffs', {}, signal);
        return diffs.sort((a, b) => b.revision - a.revision)[0]?.extra_data?.[bindingKey] ? 'bound' : 'squash';
    }
    async activity(id: number, signal?: AbortSignal): Promise<PublicActivity | undefined> {
        try {
            const data = await this.api<{ last_update: { type: string; timestamp: string; user?: string | { username?: string } } }>(`/review-requests/${id}/last-update/`, {}, signal);
            const update = data.last_update;
            return { id, type: update.type, timestamp: update.timestamp, actor: typeof update.user === 'string' ? update.user : update.user?.username ?? '' };
        } catch (error) {
            if (signal?.aborted) { throw error; }
            this.options.log?.(`Activity unavailable for #${id}: ${String(error)}`); return;
        }
    }
    /** One RBTools process/authentication context for the watch batch. */
    async watch(ids: number[], selectedId?: number, signal?: AbortSignal): Promise<WatchResult> {
        return JSON.parse((await this.command(['rbtflow-watch', '--json', '--disable-cache'], signal,
            { '--fields-file': JSON.stringify({ ids, selected_id: selectedId }) })).toString('utf8')) as WatchResult;
    }
    async validatePeople(fields: ReviewFields, signal?: AbortSignal): Promise<void> {
        await Promise.all([
            ...fields.people.map(async name => {
                const result = await this.api<{ user: { is_active: boolean } }>(`/users/${encodeURIComponent(name)}/`, {}, signal);
                if (!result.user.is_active) { throw new Error(`审批人 ${name} 已停用。`); }
            }),
            ...fields.groups.map(name => this.api(`/groups/${encodeURIComponent(name)}/`, {}, signal)),
        ]);
    }
    async diff(git: ReviewPlan['git'], input: ReviewPlan['input'], repository: ServerRepository, signal?: AbortSignal): Promise<Buffer> {
        return this.command(['diff', '--disable-cache', '--repository-type=git', `--repository=${repository.name}`,
            `--tracking-branch=${input.targetRef}`, '--git-find-renames-threshold=50', git.base, git.head], signal);
    }
    async post(plan: ReviewPlan, fields: ReviewFields, signal?: AbortSignal): Promise<number> {
        const args = ['post', '--json', '--disable-cache', '--repository-type=git', `--repository=${plan.repository.name}`,
            `--tracking-branch=${plan.input.targetRef}`, '--git-find-renames-threshold=50', '--guess-fields=no',
            plan.input.mode === 'history' ? '--with-history' : '--squash-history',
            `--summary=${fields.summary.trim()}`, `--branch=${fields.branch}`,
            `--field=rbtflow_plan_id=${plan.id}`];
        if (plan.bindingVersion) { args.push('--field=rbtflow_binding_version=1'); }
        if (plan.input.reviewId) { args.push('-r', String(plan.input.reviewId), `--change-description=${fields.changeDescription}`); }
        const result = JSON.parse((await this.command(args, signal, {
            '--description-file': fields.description, '--testing-done-file': fields.testing,
        }, [plan.git.base, plan.git.head])).toString('utf8')) as { status: string; review_request_id: number };
        if (result.status !== 'success' || !Number.isSafeInteger(result.review_request_id)) { throw new Error('post 未返回有效审核单 ID；请检查服务器状态。'); }
        return result.review_request_id;
    }
    async commitRequests(plan: ReviewPlan, excludeId = plan.input.reviewId ?? 0, signal?: AbortSignal, scanDrafts = true): Promise<CommitConflict['requests']> {
        const result = JSON.parse((await this.command(['rbtflow-find-commit', '--json', '--disable-cache',
            String(plan.repository.id), plan.git.head, String(excludeId), scanDrafts ? '12' : '0'], signal)).toString('utf8')) as { username: string; requests: CommitConflict['requests'] };
        if (result.username !== plan.username) { throw new ReviewSafetyError('Account changed. Sign in as the original author.'); }
        return result.requests;
    }
    async replaceFields(plan: ReviewPlan, fields: ReviewFields, id: number, signal?: AbortSignal, expected?: ReviewSnapshot, verifiedDiff?: ServerDiff): Promise<void> {
        const values: Record<string, string> = { summary: fields.summary.trim(), description: fields.description,
            testing_done: fields.testing, target_people: fields.people.join(','), target_groups: fields.groups.join(','),
            bugs_closed: fields.bugs.join(','), branch: fields.branch, description_text_type: 'plain',
            testing_done_text_type: 'plain', 'extra_data.rbtflow_plan_id': plan.id };
        if (plan.previous?.review.public) { values.changedescription = fields.changeDescription; values.changedescription_text_type = 'plain'; }
        if (plan.bindingVersion) {
            if (!fullCommitId(plan.git.head)) { throw new ReviewSafetyError('A full Git HEAD SHA is required. Preview again.'); }
            const diff = verifiedDiff ?? (await this.list<ServerDiff>(`/review-requests/${id}/draft/diffs/`, 'diffs', {}, signal))
                .sort((a, b) => b.revision - a.revision)[0];
            if (!diff) { throw new ReviewSafetyError('Uploaded diff is missing. Check the server.'); }
            values.commit_id = plan.git.head;
            values['extra_data.rbtflow_binding_version'] = '1';
            values._binding = JSON.stringify(bindingFor(plan, diff));
        }
        if (expected) { values._request_updated = expected.review.last_updated; values._draft_updated = expected.draft?.last_updated ?? ''; }
        const result = JSON.parse((await this.command(['rbtflow-sync-draft', '--json', '--disable-cache'], signal,
            { '--fields-file': JSON.stringify(values) }, [String(id)])).toString('utf8')) as { error?: { code: number; message: string }; not_applied?: boolean };
        if (result.error) {
            const brief = values.commit_id ? result.error.code === 227 || result.error.code === 204
                ? `HEAD is already linked to another request. Draft #${id} is preserved.`
                : `Commit binding failed. Draft #${id} is preserved; see Output.` : undefined;
            throw new ApiError(result.error.message, result.error.code, result.not_applied, brief);
        }
    }
    async verifyUploaded(plan: ReviewPlan, id: number, published: boolean, signal?: AbortSignal): Promise<ServerDiff> {
        const snapshot = await this.snapshot(id, signal), review = snapshot.review;
        this.assertRepository(review, plan.repository.id);
        if (review.status !== 'pending' || review.created_with_history !== (plan.input.mode === 'history') || review.links.submitter?.title !== plan.username) {
            throw new ReviewSafetyError('The request author, status or diff mode changed. Check the server.');
        }
        const prefix = `/review-requests/${id}/${published ? '' : 'draft/'}diffs/`;
        const diffs = await this.list<ServerDiff>(prefix, 'diffs', {}, signal), diff = diffs.sort((a, b) => b.revision - a.revision)[0];
        if (!diff) { throw new ReviewSafetyError('The uploaded diff is missing. Check the server.'); }
        const files = await this.list<{ dest_file: string; source_file: string }>(`${prefix}${diff.revision}/files/`, 'files', {}, signal);
        if (fileSetHash(files.map(file => file.dest_file || file.source_file)) !== fileSetHash(plan.git.files.map(file => file.path))) {
            this.options.log?.(`File set mismatch on #${id}, diff ${diff.id} v${diff.revision}`);
            throw new PatchMismatchError(id);
        }
        const expected = plan.patchContentHash ?? plan.patchHash;
        const format = plan.patchContentHash ? 'git-blocks-v1' : undefined;
        const observed = await this.patchHash(id, diff.revision, published ? 'published' : 'draft', signal, format);
        if (observed !== expected) {
            this.options.log?.(`Patch mismatch on #${id}, diff ${diff.id} v${diff.revision} (${format ?? 'raw'}): expected ${expected}, received ${observed}`);
            throw new PatchMismatchError(id);
        }
        return diff;
    }
    async verify(plan: ReviewPlan, fields: ReviewFields, id: number, published: boolean, signal?: AbortSignal): Promise<Receipt> {
        const snapshot = await this.snapshot(id, signal);
        const review = snapshot.review;
        this.assertRepository(review, plan.repository.id);
        if (review.status !== 'pending' || review.created_with_history !== (plan.input.mode === 'history')) { throw new Error('服务器审核状态/模式与计划不一致。'); }
        const details = published ? review : snapshot.draft;
        if (!details) { throw new Error('服务器缺少预期草稿。'); }
        if (plan.bindingVersion && details.commit_id !== plan.git.head) { throw new ReviewSafetyError('Commit ID does not match the uploaded HEAD. Complete the draft binding.'); }
        const equal = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
        if (details.summary !== fields.summary.trim() || details.description !== fields.description || details.testing_done !== fields.testing ||
            details.branch !== fields.branch || !equal(details.bugs_closed, fields.bugs) ||
            !equal(details.target_people.map(p => p.title!), fields.people) || !equal(details.target_groups.map(g => g.title!), fields.groups) ||
            (!published && details.extra_data.rbtflow_plan_id !== plan.id)) { throw new Error('服务器字段与本次提交不一致，请检查草稿，避免重复提交。'); }
        if (published && (!review.public || snapshot.draft)) { throw new Error('审核单尚未完整发布。'); }
        const diff = await this.verifyUploaded(plan, id, published, signal);
        if (plan.bindingVersion) {
            const binding = readBinding(diff.extra_data?.[bindingKey]), expected = bindingFor(plan, diff);
            if (!binding || binding.patchFormat !== expected.patchFormat || Object.entries(expected).some(([key, value]) => binding[key as keyof typeof binding] !== value)) { throw new ReviewSafetyError('The uploaded diff has no matching HEAD binding. Check the server.'); }
            assertBoundCommit(binding, details, diff);
        }
        if ((await this.snapshot(id, signal)).fingerprint !== snapshot.fingerprint) { throw new ReviewSafetyError('The request changed during verification. Check the server.'); }
        return { id, url: `${plan.server}r/${id}/`, diffRevision: diff.revision, published,
            fingerprint: snapshot.fingerprint, verification: 'patch-and-metadata' };
    }
    assertRepository(review: ReviewResource, id: number): void {
        const href = review.links.repository?.href;
        if (!href || !new URL(href).pathname.endsWith(`/repositories/${id}/`)) { throw new Error('审核单所属服务器仓库与选择不一致。'); }
    }
    async publish(id: number, signal?: AbortSignal): Promise<void> {
        const payload = JSON.parse((await this.command(['rbtflow-publish-request', '--json', '--disable-cache', String(id)], signal)).toString('utf8')) as { published?: boolean; error?: { code: number; message: string } };
        if (payload.error) { throw new ApiError(payload.error.message, payload.error.code); }
        if (!payload.published) { throw new Error('Publication result is unknown. Check the server.'); }
    }
}
