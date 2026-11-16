const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');
const root = path.resolve(__dirname, '..');
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
  const dir = await fs.mkdtemp(path.join(resultDir, 'run-'));
  const user = path.join(dir, 'user');
  await fs.mkdir(path.join(user, 'User'), { recursive: true });
  await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({
    'rbtflow.rbtPath': path.join(root, 'build/venv/bin/rbt'),
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'git.autofetch': false,
    'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
  }));
  const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode({ version: '1.136.1', cachePath: path.join(root, 'build/vscode-test') });
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: process.env.RBTFLOW_EXTENSION_PATH || root,
    extensionTestsPath: path.join(root, 'build/extension/test/host.js'),
    launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--no-sandbox', '--disable-gpu',
      '--skip-welcome', '--skip-release-notes', '--user-data-dir', user, '--extensions-dir', path.join(dir, 'extensions'), path.join(root, 'build/workspace')],
  });
  const reportFile = path.join(resultDir, 'latest.json');
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  report.extensionPath = process.env.RBTFLOW_EXTENSION_PATH || root;
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
}
main().catch(async error => {
  await fs.mkdir(path.join(root, 'build/host'), { recursive: true });
  await fs.writeFile(path.join(root, 'build/host/latest.json'), JSON.stringify({ status: 'FAIL', error: error.message }, null, 2));
  console.error(error); process.exitCode = 1;
});
