import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runProcess } from '../adapters/process';
import { PendingStore } from '../application/reviewSession';
import { PendingWrite, ReviewFields, ReviewInput } from '../domain/model';

export const project = path.resolve(__dirname, '../../..');
export const labRoot = path.join(project, 'build/workspace');
export const rbtPath = path.join(project, 'build/venv/bin/rbt');
export const fields: ReviewFields = { summary: 'RBTFlow TypeScript integration', description: '测试真实扩展审核链路。',
    testing: 'Git tree / Review Board readback', people: ['reviewer'], groups: ['reviewers'], bugs: ['1234', 'TEST-5678'],
    branch: 'origin/main', changeDescription: '更新审核验证' };
export const input: ReviewInput = { server: '', repositoryId: 1, targetRef: 'origin/main', baseRef: '', mode: 'bound', reviewId: null };
export async function temporary(prefix: string): Promise<string> {
    await mkdir(path.join(project, 'build/tests'), { recursive: true });
    return mkdtemp(path.join(project, 'build/tests', prefix));
}
export async function git(root: string, ...args: string[]): Promise<Buffer> { return runProcess('git', args, { cwd: root }); }
/** Synthetic test repos only: preserve the tree/parents while giving each run a unique real HEAD. */
export async function uniqueFixtureHead(root: string): Promise<void> {
    await git(root, 'commit', '--amend', '-m', `RBTFlow isolated acceptance ${crypto.randomUUID()}`);
}
/** Only the disposable local lab is addressed; never accept a production server here. */
export async function labApi<T>(resource: string, method = 'GET', body?: URLSearchParams | FormData, user = 'admin'): Promise<T> {
    const response = await fetch('http://127.0.0.1:8080/api' + resource, { method, body,
        headers: { Authorization: `Basic ${Buffer.from(`${user}:rbtflow-local`).toString('base64')}` } });
    if (response.status === 204) { return { stat: 'ok' } as T; }
    const result = await response.json() as { stat: string; err?: unknown; fields?: unknown };
    assertLab(result.stat === 'ok', `${method} ${resource}: ${JSON.stringify({ status: response.status, error: result.err, fields: result.fields })}`);
    return result as T;
}
function assertLab(ok: boolean, message: string): asserts ok { if (!ok) { throw new Error(message); } }
/** Authenticated, read-only HTML visit; credentials/cookies never leave this local helper. */
export async function labPage(id: number): Promise<number> {
    const server = 'http://127.0.0.1:8080/', cookies = new Map<string, string>();
    const remember = (response: Response) => {
        for (const cookie of response.headers.getSetCookie()) {
            const pair = cookie.split(';')[0]!, at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1));
        }
    };
    const header = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    remember(await fetch(server + 'account/login/'));
    const token = cookies.get('csrftoken'); assertLab(!!token, 'Missing local CSRF cookie');
    const login = await fetch(server + 'account/login/', { method: 'POST', redirect: 'manual', headers: { Cookie: header(), Referer: server + 'account/login/' },
        body: new URLSearchParams({ username: 'admin', password: 'rbtflow-local', csrfmiddlewaretoken: token, next: `/r/${id}/` }) });
    remember(login); assertLab(login.status === 302, 'Local browser login failed');
    const page = await fetch(`${server}r/${id}/`, { headers: { Cookie: header() } }); await page.text();
    assertLab(page.status === 200, `Local page returned ${page.status}`); return page.status;
}
export async function fixtures(): Promise<{ dir: string; root: string; specs: Record<string, { base: string; head: string }> }> {
    const dir = await temporary('git-');
    await runProcess('python3', ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,"scripts"); from fixtures import create; create(Path(sys.argv[1]))', dir], { cwd: project });
    const data = JSON.parse(await readFile(path.join(dir, 'fixtures.json'), 'utf8')) as { scenarios: Record<string, { base: string; head: string }> };
    return { dir, root: path.join(dir, 'workspace'), specs: data.scenarios };
}
export class FilePending implements PendingStore {
    private value?: PendingWrite;
    constructor(private readonly filename: string) {}
    async initialize(): Promise<void> {
        this.value = await readFile(this.filename, 'utf8').then(data => JSON.parse(data) as PendingWrite, () => undefined);
    }
    load(): PendingWrite | undefined { return this.value; }
    async save(value: PendingWrite | undefined): Promise<void> {
        this.value = value;
        await writeFile(this.filename, JSON.stringify(value ?? null), { mode: 0o600 });
    }
}
