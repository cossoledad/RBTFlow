import { spawn } from 'node:child_process';

export class ProcessError extends Error {
    constructor(message: string, readonly stdout: Buffer, readonly stderr: Buffer,
                readonly reason: 'exit' | 'cancelled' | 'timeout' | 'limit' | 'spawn') {
        super(message);
        this.name = 'ProcessError';
    }
}

export interface RunOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
}

/** No shell, closed stdin, bounded output; cancellation waits for process exit. */
export function runProcess(executable: string, args: string[], options: RunOptions): Promise<Buffer> {
    if (options.signal?.aborted) {
        return Promise.reject(new ProcessError('操作已取消。', Buffer.alloc(0), Buffer.alloc(0), 'cancelled'));
    }
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd: options.cwd, env: options.env ?? process.env, shell: false,
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
        });
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let size = 0;
        let reason: ProcessError['reason'] | undefined;
        let escalation: NodeJS.Timeout | undefined;
        const kill = (signal: NodeJS.Signals) => {
            try {
                if (process.platform !== 'win32' && child.pid) { process.kill(-child.pid, signal); }
                else { child.kill(signal); }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { child.kill(signal); }
            }
        };
        const stop = (why: ProcessError['reason']) => {
            if (reason) { return; }
            reason = why;
            kill('SIGTERM');
            escalation = setTimeout(() => kill('SIGKILL'), 1500);
        };
        const collect = (chunks: Buffer[], data: Buffer) => {
            size += data.length;
            if (size > (options.maxBytes ?? 64 * 1024 * 1024)) { stop('limit'); }
            else { chunks.push(data); }
        };
        child.stdout.on('data', (data: Buffer) => collect(stdout, data));
        child.stderr.on('data', (data: Buffer) => collect(stderr, data));
        const abort = () => stop('cancelled');
        options.signal?.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(() => stop('timeout'), options.timeoutMs ?? 120_000);
        const cleanup = () => {
            clearTimeout(timeout);
            if (escalation) { clearTimeout(escalation); }
            options.signal?.removeEventListener('abort', abort);
        };
        child.on('error', error => {
            cleanup();
            reject(new ProcessError(`无法运行 ${executable}：${error.message}`, Buffer.concat(stdout), Buffer.concat(stderr), 'spawn'));
        });
        child.on('close', code => {
            cleanup();
            const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
            if (!reason && code === 0) { resolve(out); return; }
            const message = reason === 'cancelled' ? '操作已取消。' : reason === 'timeout' ? '命令执行超时。' :
                reason === 'limit' ? '命令输出超过 64 MiB 限制，请缩小审核范围。' :
                err.toString('utf8').trim() || `命令退出码：${code}`;
            reject(new ProcessError(message, out, err, reason ?? 'exit'));
        });
    });
}
