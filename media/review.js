(() => {
  const vscode = acquireVsCodeApi(), el = id => document.getElementById(id);
  const fields = ['summary', 'description', 'testing', 'branch', 'changeDescription'];
  const lists = ['people', 'groups', 'bugs'];
  let state, timer, forceValues = false;
  const unique = text => [...new Set(text.split(',').map(value => value.trim()).filter(Boolean))];
  function form() {
    const data = { ...state.form };
    for (const key of fields) data[key] = el(key).value;
    for (const key of lists) data[key] = unique(el(key).value);
    data.reviewId = el('reviewId').value ? Number(el('reviewId').value) : null;
    return data;
  }
  function send(type, extra = {}) {
    if (!state) return;
    clearTimeout(timer);
    const own = ['edit', 'preview', 'post', 'publish', 'new', 'load'].includes(type);
    const feedback = ['saveFeedback','publishFeedback'].includes(type) ? { body: el('reviewBody').value, shipIt: el('shipIt').checked } : {};
    vscode.postMessage({ type, root: state.root, ...(own ? { form: form() } : {}), ...feedback, planId: state.plan?.id, ...extra });
  }
  function value(id, text) { if (el(id).value !== text && (forceValues || document.activeElement !== el(id) || state.busy)) el(id).value = text; }
  function render(next) {
    forceValues = !state || state.root !== next?.root || state.form.reviewId !== next?.form.reviewId || state.remote?.id !== next?.remote?.id;
    state = next; el('welcome').hidden = !!next; el('workbench').hidden = !next; if (!next) return;
    if (el('more').dataset.root !== next.root) { el('more').dataset.root = next.root; el('more').open = next.moreOpen; }
    el('selectRoot').textContent = next.rootName + ' ▾'; el('selectRoot').title = next.root;
    el('submitMode').classList.toggle('active', next.mode === 'submit'); el('browseMode').classList.toggle('active', next.mode === 'browse');
    el('submitSection').hidden = next.mode !== 'submit'; el('browseSection').hidden = next.mode !== 'browse';
    for (const key of fields) value(key, next.form[key]);
    for (const key of lists) if (JSON.stringify(unique(el(key).value)) !== JSON.stringify(next.form[key])) value(key, next.form[key].join(', '));
    value('reviewId', next.form.reviewId == null ? '' : String(next.form.reviewId));
    value('browseId', next.browseId == null ? '' : String(next.browseId));
    el('target').textContent = '目标：' + (next.form.targetRef || '选择主线') + ' ▾';
    el('editing').hidden = !next.form.reviewId; el('editingLabel').textContent = '#' + next.form.reviewId;
    el('status').textContent = next.status; el('status').hidden = !next.status;
    el('error').textContent = next.error; el('error').hidden = !next.error;
    el('pending').hidden = !next.pending; el('pendingContext').textContent = next.pendingContext;
    el('feedbackPending').hidden = !next.feedbackPending; el('feedbackPendingContext').textContent = next.feedbackPendingContext;
    el('rangeDetails').hidden = !next.plan;
    if (next.plan) {
      el('counts').textContent = `${next.plan.files} 个更改 · ${next.plan.commits} 个提交 · ${next.plan.merges} 个 merge`;
      el('gitBranch').textContent = next.plan.branch; el('baseSha').textContent = next.plan.base; el('headSha').textContent = next.plan.head;
      el('warnings').replaceChildren(...next.plan.warnings.map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
    }
    el('remoteDetails').hidden = !next.remote;
    if (next.remote) {
      const remote = next.remote;
      el('remoteTitle').textContent = remote.title || '#' + remote.requestId;
      el('remoteMeta').textContent = `${remote.author} · ${remote.repository} · ${remote.files} 个更改`;
      const key = JSON.stringify(remote.versions);
      if (el('version').dataset.key !== key) {
        el('version').dataset.key = key;
        el('version').replaceChildren(...remote.versions.map(item => { const option = document.createElement('option'); option.value = item.scope + ':' + item.revision; option.textContent = (item.scope === 'draft' ? '我的草稿' : '已发布') + ' v' + item.revision; return option; }));
      }
      value('version', remote.selected.scope + ':' + remote.selected.revision);
      el('remoteDescription').textContent = remote.description; el('remoteTesting').textContent = remote.testing;
      el('editOwn').hidden = !remote.canEdit; el('feedbackArea').hidden = !remote.canReview;
    }
    value('reviewBody', next.feedback.body); el('shipIt').checked = next.feedback.shipIt;
    const unsaved = next.localCommentCount;
    el('commentCount').textContent = [next.savedCommentCount ? `${next.savedCommentCount} 条服务器草稿评论` : '', unsaved ? `${unsaved} 条本地行内意见` : ''].filter(Boolean).join(' · ');
    el('feedbackRestriction').hidden = !next.feedbackRestriction; el('feedbackRestriction').textContent = next.feedbackRestriction;
    el('draftBottom').hidden = !next.draftBottom; el('draftBottom').textContent = next.draftBottom ? '服务器草稿附加意见：\n' + next.draftBottom : '';
    el('feedbackConflict').hidden = !next.feedbackConflict;
    for (const node of document.querySelectorAll('button,input,textarea,select')) node.disabled = next.busy;
    el('post').disabled = next.busy || !next.canPost; el('post').textContent = next.form.reviewId ? '更新草稿' : '保存草稿';
    el('publish').hidden = !next.receipt || next.receipt.published; el('publish').disabled = next.busy || !next.canPublish;
    el('saveFeedback').disabled = next.busy || next.feedbackPending || next.feedbackConflict || !!next.feedbackRestriction;
    el('publishFeedback').disabled = next.busy || !next.canPublishFeedback;
    el('openUrl').hidden = next.mode === 'browse' ? !next.remote : !next.receipt;
    el('cancel').hidden = !next.busy; el('cancel').disabled = false;
    vscode.postMessage({ type: 'rendered', root: next.root, comparisonId: next.mode === 'browse' ? next.remote?.id || null : next.plan?.id || null,
      canPost: !el('post').disabled, canPublish: !el('publish').disabled && !el('publish').hidden,
      canPublishFeedback: !el('publishFeedback').disabled, mode: next.mode });
  }
  for (const id of ['preview','post','publish','new','load','myReviews','reconcile','reconcileFeedback','clearPending','saveFeedback','publishFeedback','reloadFeedback','selectRoot','settings','openUrl','cancel']) el(id).onclick = () => send(id);
  el('clearFeedbackPending').onclick = () => send('clearPending');
  el('submitMode').onclick = () => send('mode', { mode: 'submit' }); el('browseMode').onclick = () => send('mode', { mode: 'browse' });
  el('target').onclick = () => send('settings', { setting: 'targetRef' });
  el('peopleSearch').onclick = () => { send('edit'); send('people'); }; el('groupsSearch').onclick = () => { send('edit'); send('groups'); };
  el('editOwn').onclick = () => send('load');
  el('openRemote').onclick = () => send('openRemote', { reviewId: Number(el('browseId').value) });
  el('viewSaved').onclick = () => send('openRemote', { reviewId: state.form.reviewId });
  el('browseId').onkeydown = event => { if (event.key === 'Enter') el('openRemote').click(); };
  el('version').onchange = () => { const [scope, revision] = el('version').value.split(':'); send('version', { scope, revision: Number(revision) }); };
  for (const key of [...fields, ...lists, 'reviewId']) el(key).oninput = () => { clearTimeout(timer); timer = setTimeout(() => send('edit'), 160); };
  for (const key of [...fields, ...lists, 'reviewId']) el(key).addEventListener('focusout', () => { if (state && !state.busy) send('edit'); });
  const feedback = () => { clearTimeout(timer); timer = setTimeout(() => send('feedbackEdit', { body: el('reviewBody').value, shipIt: el('shipIt').checked }), 160); };
  el('reviewBody').oninput = feedback; el('shipIt').onchange = feedback;
  el('reviewBody').addEventListener('focusout', () => { if (state && !state.busy) send('feedbackEdit', { body: el('reviewBody').value, shipIt: el('shipIt').checked }); });
  el('more').ontoggle = () => { if (state) send('more', { open: el('more').open }); };
  window.addEventListener('message', event => { if (event.data?.type === 'state') render(event.data.state); });
  window.addEventListener('blur', () => { if (state && !state.busy) { if (state.mode === 'submit') send('edit'); else send('feedbackEdit', { body: el('reviewBody').value, shipIt: el('shipIt').checked }); } });
  vscode.postMessage({ type: 'ready' });
})();
