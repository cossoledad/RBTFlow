const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && executable.endsWith('.cmd') });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const action = process.argv[2];
try {
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  const hash = createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex');
  const marker = path.join(root, 'node_modules/.rbtflow-lock');
  if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== hash) {
    run(npm, ['ci']); fs.writeFileSync(marker, hash);
  }
  if (action === 'integration' || action === 'host-smoke') run('bash', ['dev.sh', 'start']);
  const scripts = { prepare: 'compile', watch: 'watch', test: 'test', integration: 'test:integration', 'host-smoke': 'test:host', package: 'package' };
  if (!scripts[action]) throw new Error('Unknown extension action');
  run(npm, ['run', scripts[action]]);
} catch (error) { console.error(error.message); process.exitCode = 1; }
