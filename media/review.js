/* Webview has no filesystem or network access. All operations go through host messages. */
(() => {
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const listFields = ['people', 'groups', 'bugs'];
  const textFields = ['server', 'targetRef', 'baseRef', 'summary', 'description', 'testing', 'branch', 'changeDescription'];
  let state;
  let timer;
  const unique = value => [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];
  function form() {
    const result = {};
    for (const key of textFields) { result[key] = byId(key).value; }
    for (const key of listFields) { result[key] = unique(byId(key).value); }
    for (const key of ['repositoryId', 'reviewId']) { result[key] = byId(key).value ? Number(byId(key).value) : null; }
    result.mode = byId('mode').value;
    return result;
  }
  function send(type, extra = {}) {
    clearTimeout(timer);
    vscode.postMessage({ type, form: form(), planId: state?.plan?.id, ...extra });
  }
  function options(id, values, selected, placeholder) {
    const node = byId(id);
    const key = JSON.stringify([values, selected]);
    if (node.dataset.key === key) { return; }
    node.dataset.key = key;
    const items = [];
    if (placeholder !== undefined) {
      const item = document.createElement('option'); item.value = ''; item.textContent = placeholder; items.push(item);
    }
    for (const value of values) {
      const option = document.createElement('option');
      option.value = String(value.value); option.textContent = value.label; items.push(option);
    }
    node.replaceChildren(...items);
    node.value = selected == null ? '' : String(selected);
  }
  function render(next) {
    state = next;
    for (const key of textFields) { if (byId(key).value !== next.form[key]) { byId(key).value = next.form[key]; } }
    for (const key of listFields) {
      if (JSON.stringify(unique(byId(key).value)) !== JSON.stringify(next.form[key])) { byId(key).value = next.form[key].join(', '); }
    }
    for (const key of ['reviewId', 'mode']) {
      const value = next.form[key] == null ? '' : String(next.form[key]); if (byId(key).value !== value) { byId(key).value = value; }
    }
    options('root', next.roots.map(root => ({ value: root, label: root.split(/[\\/]/).pop() || root })), next.root);
    byId('rootPath').textContent = next.root;
    const repositories = [...next.repositories];
    if (next.form.repositoryId && !repositories.some(repo => repo.id === next.form.repositoryId)) {
      repositories.push({ id: next.form.repositoryId, name: next.plan?.repository || `仓库 #${next.form.repositoryId}` });
    }
    options('repositoryId', repositories.map(repo => ({ value: repo.id, label: `${repo.name} (#${repo.id})` })), next.form.repositoryId, '按 remote 匹配；无匹配时请连接并选择');
    options('refs', next.refs.map(ref => ({ value: ref, label: ref })), '');
    byId('status').textContent = next.status;
    byId('error').textContent = next.error; byId('error').hidden = !next.error;
    byId('pending').hidden = !next.pending;
    byId('pendingContext').textContent = next.pendingContext;
    byId('plan').hidden = !next.plan; byId('empty').hidden = !!next.plan;
    if (next.plan) {
      for (const [id, key] of [['baseSha', 'base'], ['headSha', 'head'], ['targetSha', 'target']]) { byId(id).textContent = next.plan[key]; }
      byId('gitBranch').textContent = next.plan.branch;
      byId('counts').textContent = `${next.plan.files.length} 个文件 · ${next.plan.commits} 个提交 · ${next.plan.merges} 个 merge`;
      byId('warnings').replaceChildren(...next.plan.warnings.map(warning => { const item = document.createElement('li'); item.textContent = warning; return item; }));
      byId('files').replaceChildren(...next.plan.files.map((file, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'file'; button.title = '在 VS Code 中对比固定快照';
        const status = document.createElement('span'); status.className = 'badge'; status.textContent = file.status;
        const name = document.createElement('span'); name.className = 'name'; name.textContent = file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
        button.append(status, name); button.onclick = () => send('diff', { index }); return button;
      }));
      byId('versions').textContent = `${next.plan.repository} · Review Board ${next.plan.serverVersion} · ${next.plan.rbtVersion}`;
    }
    for (const node of document.querySelectorAll('input, textarea, select, button')) { node.disabled = next.busy; }
    byId('log').disabled = false;
    byId('cancel').hidden = !next.busy; byId('cancel').disabled = false;
    byId('post').disabled = next.busy || !next.plan || next.pending;
    byId('post').textContent = next.form.reviewId ? '更新草稿' : '保存草稿';
    byId('publish').disabled = next.busy || !next.plan || !next.receipt || next.receipt.published || next.pending || next.receipt.id !== next.form.reviewId;
    byId('openUrl').hidden = !next.receipt;
    if (next.receipt) { byId('openUrl').textContent = `打开审核 #${next.receipt.id} ↗`; }
    vscode.postMessage({ type: 'rendered', planId: next.plan?.id || null, files: byId('files').children.length,
      canPost: !byId('post').disabled, canPublish: !byId('publish').disabled });
  }
  for (const [id, type] of Object.entries({ connect: 'connect', preview: 'preview', post: 'post', publish: 'publish', load: 'load',
    peopleSearch: 'people', groupsSearch: 'groups', patch: 'patch', token: 'token', reconcile: 'reconcile', clearPending: 'clearPending' })) {
    byId(id).onclick = () => send(type);
  }
  for (const type of ['cancel', 'log', 'openUrl']) { byId(type).onclick = () => vscode.postMessage({ type }); }
  byId('root').onchange = () => vscode.postMessage({ type: 'selectRoot', root: byId('root').value });
  byId('reviewForm').onsubmit = event => event.preventDefault();
  byId('reviewForm').addEventListener('input', event => {
    if (event.target.id === 'root') { return; }
    clearTimeout(timer); timer = setTimeout(() => send('edit'), 180);
  });
  window.addEventListener('message', event => { if (event.data?.type === 'state') { render(event.data.state); } });
  vscode.postMessage({ type: 'ready' });
})();
