import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { GitAdapter } from '../adapters/git';
import { Connection, RBToolsAdapter } from '../adapters/rbtools';
import { ProcessError, runProcess } from '../adapters/process';
import { ReviewSession } from '../application/reviewSession';
import { inputKey } from '../domain/model';
import { fixtures, git, input, fields, temporary } from './helpers';

test('real Git DAG: linear, upstream merge, side merge, conflict resolution and stacked baseline', async () => {
    const data = await fixtures(), adapter = new GitAdapter();
    for (const [name, spec] of Object.entries(data.specs)) {
        await git(data.root, 'switch', '--detach', spec.head);
        const plan = await adapter.analyze(data.root, { ...input, baseRef: name === 'stacked-child' ? spec.base : '' });
        assert.equal(plan.base, spec.base, name);
        assert.equal(plan.head, spec.head, name);
        assert.equal(plan.linear, ['linear', 'stacked-child'].includes(name), name);
        assert(!plan.files.some(file => file.path === 'upstream.txt'), name);
        assert.equal(plan.files.some(file => file.path === 'side.txt'), name === 'merged-side', name);
        if (name === 'conflict-resolved') { assert.equal((await adapter.blob(data.root, plan.head, 'greeting.txt')).toString(), 'feature + upstream + manual resolution\n'); }
        if (name === 'merged') { await assert.rejects(adapter.analyze(data.root, { ...input, mode: 'history' }), /连续线性/); }
    }
});

test('worktree identity, filenames with whitespace/Unicode, rename/deletion and dirty worktree exclusion', async () => {
    const data = await fixtures(), work = path.join(data.dir, 'linked worktree');
    await git(data.root, 'worktree', 'add', '--detach', work, data.specs.merged!.head);
    const adapter = new GitAdapter();
    await git(work, 'mv', 'feature.txt', 'space ü $(literal).txt');
    await git(work, 'rm', 'greeting.txt');
    await git(work, 'commit', '-m', 'Rename and remove');
    const result = await adapter.analyze(work, input);
    assert.equal(result.root, work);
    assert.notEqual(result.gitDir, result.commonDir);
    // Explicit parent baseline exposes rename and deletion, rather than a net addition.
    const rename = await adapter.analyze(work, { ...input, baseRef: data.specs.merged!.head });
    assert(rename.files.some(file => file.status.startsWith('R') && file.oldPath === 'feature.txt' && file.path === 'space ü $(literal).txt'));
    assert(rename.files.some(file => file.status === 'D' && file.path === 'greeting.txt'));
    await writeFile(path.join(work, 'local-only.txt'), 'not committed');
    const dirty = await adapter.analyze(work, input);
    assert.equal(dirty.dirty, true);
    assert.notEqual(dirty.fingerprint, result.fingerprint);
    assert(!dirty.files.some(file => file.path === 'local-only.txt'));
    await assert.rejects(adapter.resolve(work, '--help'), /引用/);
});

test('process calls preserve literal arguments and cancellation kills a child that ignores SIGTERM', async () => {
    const cwd = await temporary('process-');
    const args = ['$(touch injected)', 'a b', '中文', 'semi;colon'];
    const output = await runProcess(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args], { cwd });
    assert.deepEqual(JSON.parse(output.toString()), args);
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); console.error(process.pid); setInterval(()=>{},1000)'], { cwd, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 300);
    try {
        await assert.rejects(pending, error => {
            assert(error instanceof ProcessError);
            assert.equal(error.reason, 'cancelled');
            const pid = Number(error.stderr.toString().trim());
            assert(pid > 0);
            assert.throws(() => process.kill(pid, 0));
            return true;
        });
    } finally { clearTimeout(timer); }
});

test('process timeout and output limit preserve failure categories', async () => {
    const cwd = await temporary('budgets-');
    await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd, timeoutMs: 100 }),
        error => error instanceof ProcessError && error.reason === 'timeout');
    await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("x".repeat(1000))'], { cwd, maxBytes: 32 }),
        error => error instanceof ProcessError && error.reason === 'limit');
});

test('API tokens stay out of argv/logs and temporary credentials are removed after failure', async () => {
    const storage = await temporary('credentials-'), token = 'test-token-should-never-be-logged';
    const logs: string[] = [];
    const backend = new RBToolsAdapter(storage, { executable: process.execPath, storage, server: 'http://127.0.0.1:8080',
        token: async () => token, log: message => logs.push(message) });
    const program = `const fs=require('node:fs'),path=require('node:path');
        const directory=process.env.RBTOOLS_CONFIG_PATH.split(path.delimiter)[0];
        const config=fs.readFileSync(path.join(directory,'.reviewboardrc'),'utf8');
        const token=JSON.parse(config.split('\\n').find(line=>line.startsWith('API_TOKEN = ')).slice(12));
        if(process.argv.some(arg=>arg.includes(token))) throw Error('token in argv');
        console.log(JSON.stringify({errors:['unexpected server response: '+token]}));
        console.error(token);process.exit(1);`;
    await assert.rejects(backend.command(['-e', program]), error => {
        assert(error instanceof ProcessError);
        assert(!error.message.includes(token)); assert(!error.stdout.includes(token)); assert(!error.stderr.includes(token));
        return true;
    });
    assert(!logs.join('\n').includes(token));
    assert.deepEqual(await readdir(path.join(storage, 'jobs')), []);
});

test('metadata edits preserve the range key, repository/ref/review changes invalidate it', () => {
    assert.equal(inputKey(input), inputKey({ ...input, ...fields }));
    for (const changed of [{ targetRef: 'main' }, { repositoryId: 2 }, { reviewId: 123 }, { mode: 'history' as const }, { server: 'http://other.invalid' }]) {
        assert.notEqual(inputKey(input), inputKey({ ...input, ...changed }));
    }
});

test('invalidated asynchronous preview cannot become the active plan', { timeout: 15_000 }, async () => {
    const data = await fixtures();
    let release!: (value: Connection) => void, notify!: () => void;
    const gate = new Promise<Connection>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { notify = resolve; });
    class Deferred extends RBToolsAdapter {
        override async connect(): Promise<Connection> { notify(); return gate; }
        override async diff(): Promise<Buffer> { return git(data.root, 'diff', 'origin/main', 'HEAD'); }
    }
    const backend = new Deferred(data.root, { executable: 'unused', storage: data.dir, server: '' });
    const session = new ReviewSession(data.root, new GitAdapter(), () => backend, { load: () => undefined, save: async () => {} });
    const pending = session.preview(input);
    await started;
    session.invalidate();
    release({ server: 'http://127.0.0.1:8080/', username: 'demo', version: 'test', supportsHistory: true,
        maxDiffSize: 0, rbtVersion: 'test', repositories: [{ id: 1, name: 'demo', path: 'unused', tool: 'Git' }] });
    await assert.rejects(pending, /过期/);
    assert.equal(session.plan, undefined);
});
