import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
    digest, DraftResource, Receipt, ReviewFields, ReviewPlan, ReviewResource, ReviewSnapshot,
    ServerRepository, serverUrl,
} from '../domain/model';
import { ProcessError, runProcess } from './process';
import { diffPrefix, LineMap, RemoteComparison, ReviewerDraft, ReviewComment } from '../domain/comparison';

export class ApiError extends Error {
    constructor(message: string, readonly code: number) { super(message); }
}
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
                    try {
                        const payload = JSON.parse(error.stdout.toString('utf8')) as { errors?: string[] };
                        if (Array.isArray(payload.errors)) { message = payload.errors.join('\n'); }
                    } catch { /* Raw CLI diagnostics remain available below. */ }
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
        return { review, draft, fingerprint: digest(JSON.stringify({ review, draft })) };
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
            `--summary=${fields.summary.trim()}`,
            `--field=rbtflow_plan_id=${plan.id}`];
        if (plan.input.reviewId) { args.push('-r', String(plan.input.reviewId), `--change-description=${fields.changeDescription}`); }
        const result = JSON.parse((await this.command(args, signal, {
            '--description-file': fields.description, '--testing-done-file': fields.testing,
        }, [plan.git.base, plan.git.head])).toString('utf8')) as { status: string; review_request_id: number };
        if (result.status !== 'success' || !Number.isSafeInteger(result.review_request_id)) { throw new Error('post 未返回有效审核单 ID；请检查服务器状态。'); }
        return result.review_request_id;
    }
    async replaceFields(plan: ReviewPlan, fields: ReviewFields, id: number, signal?: AbortSignal): Promise<void> {
        const values: Record<string, string> = { summary: fields.summary.trim(), description: fields.description,
            testing_done: fields.testing, target_people: fields.people.join(','), target_groups: fields.groups.join(','),
            bugs_closed: fields.bugs.join(','), branch: fields.branch, description_text_type: 'plain',
            testing_done_text_type: 'plain', 'extra_data.rbtflow_plan_id': plan.id };
        if (plan.previous?.review.public) { values.changedescription = fields.changeDescription; values.changedescription_text_type = 'plain'; }
        await this.command(['rbtflow-sync-draft', '--json', '--disable-cache'], signal,
            { '--fields-file': JSON.stringify(values) }, [String(id)]);
    }
    async verify(plan: ReviewPlan, fields: ReviewFields, id: number, published: boolean, signal?: AbortSignal): Promise<Receipt> {
        const snapshot = await this.snapshot(id, signal);
        const review = snapshot.review;
        this.assertRepository(review, plan.repository.id);
        if (review.status !== 'pending' || review.created_with_history !== (plan.input.mode === 'history')) { throw new Error('服务器审核状态/模式与计划不一致。'); }
        const details = published ? review : snapshot.draft;
        if (!details) { throw new Error('服务器缺少预期草稿。'); }
        const equal = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
        if (details.summary !== fields.summary.trim() || details.description !== fields.description || details.testing_done !== fields.testing ||
            details.branch !== fields.branch || !equal(details.bugs_closed, fields.bugs) ||
            !equal(details.target_people.map(p => p.title!), fields.people) || !equal(details.target_groups.map(g => g.title!), fields.groups) ||
            (!published && details.extra_data.rbtflow_plan_id !== plan.id)) { throw new Error('服务器字段与本次提交不一致，请检查草稿，避免重复提交。'); }
        if (published && (!review.public || snapshot.draft)) { throw new Error('审核单尚未完整发布。'); }
        const prefix = `/review-requests/${id}/${published ? '' : 'draft/'}diffs/`;
        const diffs = await this.list<{ revision: number }>(prefix, 'diffs', {}, signal);
        const revision = Math.max(...diffs.map(diff => diff.revision));
        if (!Number.isFinite(revision)) { throw new Error('服务器未保存 diff。'); }
        const files = await this.list<{ dest_file: string; source_file: string; status: string }>(`${prefix}${revision}/files/`, 'files', {}, signal);
        const actual = files.map(file => file.dest_file || file.source_file).sort();
        const expected = plan.git.files.map(file => file.path).sort();
        if (!equal(actual, expected)) { throw new Error('上传后的文件集合与预览不一致，请检查服务器 diff。'); }
        const hash = JSON.parse((await this.command(['rbtflow-verify-patch', '--json', '--disable-cache',
            String(id), String(revision), published ? 'published' : 'draft'], signal)).toString('utf8')) as { patch_hash: string };
        if (hash.patch_hash !== plan.patchHash) { throw new Error('服务端保存的主 patch 与预览不一致，请检查服务器 diff。'); }
        return { id, url: `${plan.server}r/${id}/`, diffRevision: revision, published,
            fingerprint: snapshot.fingerprint, verification: 'patch-and-metadata' };
    }
    assertRepository(review: ReviewResource, id: number): void {
        const href = review.links.repository?.href;
        if (!href || !new URL(href).pathname.endsWith(`/repositories/${id}/`)) { throw new Error('审核单所属服务器仓库与选择不一致。'); }
    }
    async publish(id: number, signal?: AbortSignal): Promise<void> {
        const payload = JSON.parse((await this.command(['publish', '--json', '--disable-cache', String(id)], signal)).toString('utf8')) as { status: string };
        if (payload.status !== 'success') { throw new Error('发布结果不明，请核对服务器。'); }
    }
}
