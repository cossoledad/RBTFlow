const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');
const root = path.resolve(__dirname, '..');
async function git(args) {
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', path.join(root, 'build/workspace'), ...args], { cwd: root, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Git fixture command failed')));
  });
}
async function ensureReviewFixture() {
  const headers = { Authorization: `Basic ${Buffer.from('admin:rbtflow-local').toString('base64')}` };
  try {
    const fixture = JSON.parse(await fs.readFile(path.join(root, 'build/review-test-fixture.json'), 'utf8'));
    if (!Number.isSafeInteger(fixture.alternateRequestId)) throw new Error('Missing fixture ID');
    const resource = `http://127.0.0.1:8080/api/review-requests/${fixture.alternateRequestId}/`;
    const data = await fetch(resource, { headers }).then(response => response.json());
    const draft = await fetch(resource + 'reviews/draft/', { headers }).then(response => response.json());
    if (data.review_request?.public && data.review_request.links.submitter?.title === 'reviewer' && draft.err?.code === 100) return;
  } catch { /* Missing/stale local-lab data will be prepared below. */ }
  console.log('Preparing another author\'s real Review Board comparison fixture…');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', path.join(root, 'build/extension/test/review.test.js')], { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Review fixture preparation failed')));
  });
}
async function ensureCollaborationFixture() {
  try {
    const fixture = JSON.parse(await fs.readFile(path.join(root, 'build/collaboration-fixture.json'), 'utf8'));
    const headers = { Authorization: `Basic ${Buffer.from('admin:rbtflow-local').toString('base64')}` };
    const data = await fetch(`http://127.0.0.1:8080/api/review-requests/${fixture.inboxRequestId}/`, { headers }).then(response => response.json());
    if (data.review_request?.public && data.review_request.status === 'pending' && data.review_request.target_people.some(person => person.title === 'admin')) return;
  } catch { /* Fresh labs prepare their own public discussion and incoming request. */ }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', path.join(root, 'build/extension/test/collaboration.test.js')], { cwd: root, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Collaboration fixture preparation failed')));
  });
}
async function main() {
  const resultDir = path.join(root, 'build/host');
  await fs.mkdir(resultDir, { recursive: true });
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    // Keep the actual extension-host run identical on desktop and CI displays.
    const child = spawn('xvfb-run', ['-a', process.execPath, __filename], { cwd: root, stdio: 'inherit' });
    child.on('error', async () => {
      await fs.writeFile(path.join(resultDir, 'latest.json'), JSON.stringify({ status: 'BLOCKED', reason: '需要 DISPLAY 或安装 xvfb-run。' }));
      console.error('Extension Host 测试需要 DISPLAY 或 xvfb-run；可在桌面终端运行，或提供 Xvfb。'); process.exitCode = 1;
    });
    child.on('exit', code => { process.exitCode = code ?? 1; });
    return;
  }
  await ensureReviewFixture();
  await ensureCollaborationFixture();
  const dir = await fs.mkdtemp(path.join(resultDir, 'run-'));
  const workspace = path.join(dir, 'workspace');
  await git(['worktree', 'add', '--detach', workspace, 'feature/merged']);
  await fs.copyFile(path.join(root, 'build/workspace/.reviewboardrc'), path.join(workspace, '.reviewboardrc')); await fs.chmod(path.join(workspace, '.reviewboardrc'), 0o600);
  await fs.mkdir(path.join(workspace, 'src/features'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'src/Unicode space'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src/features/review.ts'), 'export const nativeReview = true;\n');
  await fs.writeFile(path.join(workspace, 'src/Unicode space/说明.md'), 'Native tree validation\n');
  await git(['-C', workspace, 'add', 'src']); await git(['-C', workspace, 'commit', '-m', 'Validate native review views', '-m', 'Add nested files for tree and list comparison.']);
  const user = path.join(dir, 'user');
  await fs.mkdir(path.join(user, 'User'), { recursive: true });
  await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({
    'rbtflow.rbtPath': path.join(root, 'build/venv/bin/rbt'),
    'rbtflow.notifications.enabled': false,
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'git.autofetch': false,
    'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
  }));
  const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode({ version: '1.136.1', cachePath: path.join(root, 'build/vscode-test') });
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: process.env.RBTFLOW_EXTENSION_PATH || root,
    extensionTestsPath: process.env.RBTFLOW_HOST_TESTS_PATH || path.join(root, 'build/extension/test/host.js'),
    extensionTestsEnv: { RBTFLOW_HOST_ROOT: workspace },
    launchArgs: [...(process.env.RBTFLOW_CDP_PORT ? [`--remote-debugging-port=${process.env.RBTFLOW_CDP_PORT}`] : []), '--disable-extensions', '--disable-workspace-trust', '--no-sandbox', '--disable-gpu',
      '--skip-welcome', '--skip-release-notes', '--user-data-dir', user, '--extensions-dir', path.join(dir, 'extensions'), workspace],
  });
  const reportFile = path.join(resultDir, 'latest.json');
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  report.extensionPath = process.env.RBTFLOW_EXTENSION_PATH || root;
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  await git(['worktree', 'remove', '--force', workspace]);
}
main().catch(async error => {
  await fs.mkdir(path.join(root, 'build/host'), { recursive: true });
  await fs.writeFile(path.join(root, 'build/host/latest.json'), JSON.stringify({ status: 'FAIL', error: error.message }, null, 2));
  console.error(error); process.exitCode = 1;
});
