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
    branch: 'main', changeDescription: '更新审核验证' };
export const input: ReviewInput = { server: '', repositoryId: 1, targetRef: 'origin/main', baseRef: '', mode: 'squash', reviewId: null };
export async function temporary(prefix: string): Promise<string> {
    await mkdir(path.join(project, 'build/tests'), { recursive: true });
    return mkdtemp(path.join(project, 'build/tests', prefix));
}
export async function git(root: string, ...args: string[]): Promise<Buffer> { return runProcess('git', args, { cwd: root }); }
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
