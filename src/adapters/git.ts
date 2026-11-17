import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { ChangedFile, digest, GitAnalysis, ReviewInput } from '../domain/model';
import { ProcessError, runProcess } from './process';

function text(bytes: Buffer): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('仓库路径或文件名不是有效的 UTF-8，当前版本无法安全表示。'); }
}

export class GitAdapter {
    constructor(readonly executable = 'git') {}
    run(cwd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
        return runProcess(this.executable, ['--no-pager', ...args], {
            cwd, signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8' },
        });
    }
    async root(cwd: string, signal?: AbortSignal): Promise<string> {
        return realpath(text(await this.run(cwd, ['rev-parse', '--show-toplevel'], signal)).trimEnd());
    }
    async resolve(root: string, ref: string, signal?: AbortSignal): Promise<string> {
        if (!ref.trim() || ref.includes('\0') || ref.startsWith('-')) { throw new Error('Git 引用不能为空或以 - 开头。'); }
        const oid = text(await this.run(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], signal)).trim();
        if (!/^[0-9a-f]{40,64}$/.test(oid)) { throw new Error('无法解析 Git 提交。'); }
        return oid;
    }
    async branch(root: string, signal?: AbortSignal): Promise<string> {
        try { return text(await this.run(root, ['symbolic-ref', '--short', '-q', 'HEAD'], signal)).trim(); }
        catch (error) { if (error instanceof ProcessError && error.reason === 'exit') { return '(detached HEAD)'; } throw error; }
    }
    async refs(root: string, signal?: AbortSignal): Promise<string[]> {
        return text(await this.run(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/', 'refs/remotes/'], signal))
            .trim().split('\n').filter(ref => ref && !ref.endsWith('/HEAD'));
    }
    async remotes(root: string, signal?: AbortSignal): Promise<string[]> {
        const names = text(await this.run(root, ['remote'], signal)).trim().split('\n').filter(Boolean);
        return Promise.all(names.map(async name => text(await this.run(root, ['remote', 'get-url', name], signal)).trim()));
    }
    commitMessage(root: string, base: string, head: string, signal?: AbortSignal): Promise<Buffer> {
        return this.run(root, ['log', '--reverse', '--pretty=format:%s%n%n%b', `^${base}`, head, '--'], signal);
    }
    async fingerprint(root: string, input: ReviewInput, signal?: AbortSignal): Promise<string> {
        const values = await Promise.all([
            this.resolve(root, 'HEAD', signal), this.resolve(root, input.targetRef, signal),
            input.baseRef ? this.resolve(root, input.baseRef, signal) : Promise.resolve(''),
            this.branch(root, signal), this.run(root, ['status', '--porcelain=v1', '-z'], signal),
            this.run(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/'], signal),
        ]);
        return digest(JSON.stringify(values.map(value => Buffer.isBuffer(value) ? value.toString('base64') : value)));
    }
    async analyze(cwd: string, input: ReviewInput, signal?: AbortSignal): Promise<GitAnalysis> {
        const root = await this.root(cwd, signal);
        const gitDir = text(await this.run(root, ['rev-parse', '--absolute-git-dir'], signal)).trimEnd();
        const commonDir = text(await this.run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).trimEnd();
        for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
            if (await stat(path.join(gitDir, name)).then(() => true, () => false)) {
                throw new Error('仓库正在 merge/rebase/cherry-pick 中，请先完成或中止该操作。');
            }
        }
        const fingerprint = await this.fingerprint(root, input, signal);
        const [head, target, branch] = await Promise.all([
            this.resolve(root, 'HEAD', signal), this.resolve(root, input.targetRef, signal), this.branch(root, signal),
        ]);
        let base: string;
        if (input.baseRef) {
            base = await this.resolve(root, input.baseRef, signal);
            await this.run(root, ['merge-base', '--is-ancestor', base, head], signal)
                .catch(error => {
                    if (error instanceof ProcessError && error.reason === 'exit') { throw new Error('指定 BASE 必须是当前 HEAD 的祖先。'); }
                    throw error;
                });
        } else {
            const bases = text(await this.run(root, ['merge-base', '--all', target, head], signal)).trim().split('\n').filter(Boolean);
            if (bases.length !== 1) { throw new Error('共同基线不唯一或不存在，请明确选择 BASE；浅克隆可能需要先补全历史。'); }
            base = bases[0]!;
        }
        const output = text(await this.run(root, ['diff', '--name-status', '-z', '--find-renames', base, head, '--'], signal)).split('\0');
        const files: ChangedFile[] = [];
        for (let i = 0; output[i];) {
            const status = output[i++]!;
            const oldPath = output[i++]!;
            const filename = /^[RC]/.test(status) ? output[i++]! : oldPath;
            if (!oldPath || !filename) { throw new Error('无法解析 Git 文件差异。'); }
            files.push({ status, oldPath, path: filename });
        }
        if (!files.length) { throw new Error('所选范围没有文件差异。'); }
        const log = text(await this.run(root, ['log', '--reverse', '--format=%H %T %P', `${base}..${head}`], signal)).trim().split('\n').filter(Boolean);
        let previous = base, previousTree = text(await this.run(root, ['rev-parse', base + '^{tree}'], signal)).trim();
        let linear = true, emptyCommits = false, merges = 0;
        for (const line of log) {
            const [oid, tree, ...parents] = line.split(' ');
            if (parents.length > 1) { merges++; }
            if (parents.length !== 1 || parents[0] !== previous) { linear = false; }
            if (tree === previousTree) { emptyCommits = true; }
            previous = oid!; previousTree = tree!;
        }
        const dirty = (await this.run(root, ['status', '--porcelain=v1', '-z'], signal)).length > 0;
        const warnings = ['目标主线使用本地引用；需要时请在 Git 中显式 fetch 后重新预览。'];
        if (base !== target) { warnings.push('目标分支已超出共同基线；审核仍使用 BASE → HEAD，合并前请核对目标分支的新改动。'); }
        if (dirty) { warnings.push('工作区或暂存区有修改；本次只包含已提交内容。'); }
        if (merges) { warnings.push(`范围包含 ${merges} 个 merge commit；汇总差异包含侧分支和冲突解决结果。`); }
        if (branch === '(detached HEAD)') { warnings.push('当前处于 detached HEAD；提交时仍使用固定 SHA。'); }
        if (input.mode === 'history' && (!linear || emptyCommits)) { throw new Error('逐提交审核要求连续线性历史，且不能包含 merge 或空提交。请选择汇总 diff。'); }
        if (fingerprint !== await this.fingerprint(root, input, signal)) { throw new Error('分析期间 Git 状态发生变化，请重新预览。'); }
        return { root, gitDir: await realpath(gitDir), commonDir: await realpath(commonDir), branch, head, target, base,
            fingerprint, dirty, commits: log.length, merges, linear, emptyCommits, files, warnings,
            summary: text(await this.run(root, ['log', '-1', '--format=%s', head], signal)).trim() };
    }
    async blob(root: string, oid: string, filename: string, signal?: AbortSignal): Promise<Buffer> {
        const size = Number(text(await this.run(root, ['cat-file', '-s', `${oid}:${filename}`], signal)).trim());
        if (size > 16 * 1024 * 1024) { throw new Error('单文件超过 16 MiB，请在审核网页查看。'); }
        return this.run(root, ['show', `${oid}:${filename}`], signal);
    }
}
