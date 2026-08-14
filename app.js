(() => {
  'use strict';

  const API = '/api';
  const STORAGE_KEY = 'chrome-like-shortcuts-v2';
  const canSync = location.protocol === 'http:' || location.protocol === 'https:';
  const grid = document.querySelector('#shortcutGrid');
  const dialog = document.querySelector('#shortcutDialog');
  const form = document.querySelector('#shortcutForm');
  const idInput = document.querySelector('#shortcutId');
  const nameInput = document.querySelector('#nameInput');
  const urlInput = document.querySelector('#urlInput');
  const dialogTitle = document.querySelector('#dialogTitle');
  const closeDialogButton = document.querySelector('#closeDialogButton');
  const cancelDialogButton = document.querySelector('#cancelDialogButton');
  const cardMenu = document.querySelector('#cardMenu');
  const toast = document.querySelector('#toast');
  const loginDialog = document.querySelector('#loginDialog');
  const loginForm = document.querySelector('#loginForm');
  const loginPassword = document.querySelector('#loginPassword');
  const loginError = document.querySelector('#loginError');
  let cached = readCache();
  let items = cached.items;
  let revision = cached.revision;
  let dirty = false;
  let syncing = false;
  let activeMenuId = '';
  let draggedId = '';
  let toastTimer;
  let nameWasAutoFilled = false;

  function readCache() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(saved)) return { items: saved, revision: 0 };
      return { items: Array.isArray(saved.items) ? saved.items : [], revision: Number(saved.revision || 0) };
    } catch { return { items: [], revision: 0 }; }
  }

  function saveLocal() { localStorage.setItem(STORAGE_KEY, JSON.stringify({ revision, items })); }
  function sameItems(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
  function makeId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function normalizeUrl(value) { return /^https?:\/\//i.test(value) ? value : `https://${value}`; }
  function getDomain(value) { try { return new URL(normalizeUrl(value)).hostname.replace(/^www\./, ''); } catch { return ''; } }
  function iconFor(item) { return (item.title || '✦').trim().slice(0, 1).toUpperCase(); }
  function faviconSources(item) {
    try {
      const url = new URL(item.url);
      const host = url.hostname;
      const version = item.updatedAt || item.url;
      const local = `${API}?action=icon&id=${encodeURIComponent(item.id)}&v=${encodeURIComponent(version)}`;
      return [local, `${url.origin}/favicon.ico`, `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`, `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`];
    } catch { return []; }
  }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
  function escapeJs(value) { return String(value ?? '').replace(/['\\]/g, '\\$&'); }
  function iconMarkup(item) {
    const sources = faviconSources(item);
    if (!sources.length) return escapeHtml(iconFor(item));
    return `<img src="${escapeHtml(sources[0])}" data-next="${escapeHtml(sources.slice(1).join('|'))}" data-letter="${escapeHtml(iconFor(item))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="shortcutIconError(this)">`;
  }
  function pruneIconCache() {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) return;
    controller.postMessage({ type: 'prune-icon-cache', urls: items.map((item) => faviconSources(item)[0]).filter(Boolean) });
  }
  window.shortcutIconError = (image) => {
    const next = (image.dataset.next || '').split('|').filter(Boolean);
    if (next.length) {
      image.dataset.next = next.slice(1).join('|');
      image.src = next[0];
      return;
    }
    image.replaceWith(document.createTextNode(image.dataset.letter || '✦'));
  };
  function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2200); }
  function showLogin() { if (!loginDialog.open) loginDialog.showModal(); setTimeout(() => loginPassword.focus(), 40); }

  function applyRemote(remote) {
    if (dirty) { revision = Number(remote.revision || 0); syncRemote(); return; }
    if (remote.revision === 0 && items.length > 0) { dirty = true; revision = 0; syncRemote(); return; }
    const nextItems = Array.isArray(remote.items) ? remote.items : [];
    const nextRevision = Number(remote.revision || 0);
    if (nextRevision === revision && sameItems(nextItems, items)) return;
    items = nextItems;
    revision = nextRevision;
    saveLocal();
    render();
  }

  function render() {
    grid.innerHTML = items.map(cardTemplate).join('') + '<article class="shortcut add-shortcut"><a href="#" class="shortcut-link" data-action="add"><span class="shortcut-icon">＋</span><div class="shortcut-name">添加快捷方式</div></a></article>';
    grid.querySelector('[data-action="add"]').addEventListener('click', (event) => { event.preventDefault(); openDialog(); });
    grid.querySelectorAll('[data-action="menu"]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openCardMenu(button); }));
    grid.querySelectorAll('.shortcut[data-id]').forEach((card) => {
      let longPressTimer;
      let longPressTriggered = false;
      let touchDragging = false;
      let touchMoved = false;
      const clearLongPress = () => { clearTimeout(longPressTimer); };
      card.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'touch') return;
        card.setPointerCapture?.(event.pointerId);
        longPressTriggered = false;
        touchDragging = false;
        touchMoved = false;
        longPressTimer = setTimeout(() => {
          card.classList.add('show-actions');
          card.classList.add('dragging');
          longPressTriggered = true;
          touchDragging = true;
          if (navigator.vibrate) navigator.vibrate(25);
        }, 550);
      });
      card.addEventListener('pointermove', (event) => {
        if (event.pointerType !== 'touch' || !touchDragging) return;
        event.preventDefault();
        touchMoved = true;
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.shortcut[data-id]');
        if (!target || target === card || target.parentElement !== grid) return;
        const rect = target.getBoundingClientRect();
        const insertAfter = event.clientY > rect.top + rect.height / 2;
        if (insertAfter) grid.insertBefore(card, target.nextSibling);
        else grid.insertBefore(card, target);
      });
      card.addEventListener('pointerup', clearLongPress);
      card.addEventListener('pointercancel', clearLongPress);
      card.addEventListener('pointerleave', clearLongPress);
      card.addEventListener('pointerup', () => {
        if (!touchDragging) return;
        touchDragging = false;
        card.classList.remove('dragging');
        if (touchMoved) {
          const order = [...grid.querySelectorAll('.shortcut[data-id]')].map((entry) => entry.dataset.id);
          items = order.map((id) => items.find((item) => item.id === id)).filter(Boolean);
          changed('顺序已保存');
          card.classList.remove('show-actions');
        }
      });
      card.addEventListener('pointercancel', () => { touchDragging = false; card.classList.remove('dragging'); });
      card.addEventListener('click', (event) => {
        if (longPressTriggered) {
          event.preventDefault();
          event.stopPropagation();
          longPressTriggered = false;
        }
      }, true);
      card.addEventListener('dragstart', () => { draggedId = card.dataset.id; card.classList.add('dragging'); });
      card.addEventListener('dragend', () => { draggedId = ''; card.classList.remove('dragging'); });
      card.addEventListener('dragover', (event) => event.preventDefault());
      card.addEventListener('drop', (event) => { event.preventDefault(); reorder(draggedId, card.dataset.id); });
    });
    pruneIconCache();
  }

  function cardTemplate(item) {
    return `<article class="shortcut" data-id="${escapeHtml(item.id)}" draggable="true">
      <a class="shortcut-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
        <span class="shortcut-icon">${iconMarkup(item)}</span>
        <div class="shortcut-name">${escapeHtml(item.title)}</div>
        <div class="shortcut-url">${escapeHtml(getDomain(item.url))}</div>
      </a>
      <button class="shortcut-more" data-action="menu" data-id="${escapeHtml(item.id)}" type="button" aria-label="编辑或删除">⋮</button>
    </article>`;
  }

  function changed(message) {
    items.forEach((item) => { if (!item.updatedAt) item.updatedAt = new Date().toISOString(); });
    dirty = true;
    saveLocal();
    render();
    showToast(message);
    syncRemote();
  }

  async function getRemote() {
    const response = await fetch(`${API}?t=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) { const error = new Error('需要登录'); error.auth = true; throw error; }
    if (!response.ok) throw new Error(`GET ${response.status}`);
    return response.json();
  }

  async function loadRemote() {
    if (!canSync || syncing) return;
    try {
      const remote = await getRemote();
      applyRemote(remote);
    } catch (error) { if (error.auth) showLogin(); /* 服务器不可用时继续使用本机缓存 */ }
  }

  async function syncRemote() {
    if (!canSync || syncing || !dirty) return;
    syncing = true;
    try {
      const response = await fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ baseRevision: revision, items }),
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const payload = await response.json();
      if (response.status === 401) { showLogin(); return; }
      if (response.status === 409 && payload.state) {
        revision = Number(payload.state.revision || 0);
        syncing = false;
        syncRemote();
        return;
      }
      if (!response.ok) throw new Error(payload.message || '保存失败');
      items = Array.isArray(payload.items) ? payload.items : items;
      revision = Number(payload.revision || revision);
      dirty = false;
      saveLocal();
      render();
    } catch { /* 保留 dirty，下次轮询或恢复网络后重试 */ }
    syncing = false;
  }

  function openDialog(id = '') {
    const item = items.find((entry) => entry.id === id);
    idInput.value = item?.id || '';
    nameInput.value = item?.title || '';
    urlInput.value = item?.url || '';
    nameWasAutoFilled = !item;
    dialogTitle.textContent = item ? '编辑快捷方式' : '添加快捷方式';
    dialog.showModal();
    setTimeout(() => urlInput.focus(), 40);
  }

  function save(event) {
    event.preventDefault();
    const rawUrl = urlInput.value.trim();
    if (!rawUrl) return;
    const url = normalizeUrl(rawUrl);
    try { new URL(url); } catch { showToast('请输入正确的网址'); return; }
    const title = nameInput.value.trim() || getDomain(url);
    const existing = items.find((item) => item.id === idInput.value);
    if (existing) { existing.title = title; existing.url = url; existing.updatedAt = new Date().toISOString(); }
    else items.push({ id: makeId(), title, url, updatedAt: new Date().toISOString() });
    saveLocal();
    dialog.close();
    changed(existing ? '已更新' : '已添加');
  }

  function openCardMenu(button) {
    activeMenuId = button.dataset.id;
    const rect = button.getBoundingClientRect();
    cardMenu.hidden = false;
    cardMenu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 100)}px`;
    cardMenu.style.left = `${Math.min(rect.right - 120, window.innerWidth - 135)}px`;
  }
  function closeMenu() { cardMenu.hidden = true; grid.querySelectorAll('.show-actions').forEach((card) => card.classList.remove('show-actions')); }

  function reorder(fromId, toId) {
    if (!fromId || fromId === toId) return;
    const from = items.findIndex((item) => item.id === fromId);
    const to = items.findIndex((item) => item.id === toId);
    if (from < 0 || to < 0) return;
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    changed('顺序已保存');
  }

  async function exportItems() {
    let backup = { revision, updatedAt: new Date().toISOString(), items };
    if (canSync) {
      try {
        backup = await getRemote();
      } catch (error) {
        if (error.auth) { showLogin(); return; }
        showToast('无法读取服务器数据');
        return;
      }
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `shortcuts-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast('服务器数据已导出');
  }

  function importItems(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const incoming = JSON.parse(reader.result);
        const source = Array.isArray(incoming) ? incoming : incoming.items;
        if (!Array.isArray(source)) throw new Error();
        items = source.filter((item) => item?.title && item?.url).map((item) => ({ id: item.id || makeId(), title: String(item.title), url: normalizeUrl(String(item.url)), updatedAt: new Date().toISOString() }));
        changed(`已导入 ${items.length} 个快捷方式`);
      } catch { showToast('导入文件格式不正确'); }
      event.target.value = '';
    };
    reader.readAsText(file);
  }

  form.addEventListener('submit', save);
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginError.textContent = '';
    try {
      const response = await fetch(`${API}?action=login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password: loginPassword.value }),
        credentials: 'same-origin',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '登录失败');
      loginDialog.close();
      loginForm.reset();
      loadRemote();
    } catch (error) { loginError.textContent = error.message || '登录失败'; }
  });
  closeDialogButton.addEventListener('click', () => dialog.close());
  cancelDialogButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  urlInput.addEventListener('input', () => {
    if (!nameWasAutoFilled && nameInput.value.trim()) return;
    const suggested = getDomain(urlInput.value.trim());
    if (suggested) { nameInput.value = suggested; nameWasAutoFilled = true; }
  });
  nameInput.addEventListener('input', () => { nameWasAutoFilled = false; });
  document.querySelector('#editButton').addEventListener('click', () => { closeMenu(); openDialog(activeMenuId); });
  document.querySelector('#deleteButton').addEventListener('click', () => {
    const item = items.find((entry) => entry.id === activeMenuId);
    closeMenu();
    if (item && confirm(`删除“${item.title}”？`)) { items = items.filter((entry) => entry.id !== activeMenuId); changed('已删除'); }
  });
  document.querySelector('#exportButton').addEventListener('click', exportItems);
  document.querySelector('#importButton').addEventListener('click', () => document.querySelector('#importInput').click());
  document.querySelector('#importInput').addEventListener('change', importItems);
  document.addEventListener('click', closeMenu);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadRemote(); });
  window.addEventListener('online', () => { if (dirty) syncRemote(); else loadRemote(); });

  render();
  loadRemote();
  setInterval(() => { if (!document.hidden) dirty ? syncRemote() : loadRemote(); }, 4000);
})();
