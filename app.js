(() => {
  'use strict';

  const DATA_URL = './shortcuts.json';
  const STORAGE_KEY = 'chrome-like-shortcuts-static-v1';
  const maxItems = 1000;
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
  const dataStatus = document.querySelector('#dataStatus');
  let cached = readCache();
  let items = cached.items;
  let revision = cached.revision;
  let dirty = cached.dirty;
  let activeMenuId = '';
  let moveModeId = '';
  let draggedId = '';
  let toastTimer;
  let nameWasAutoFilled = false;

  function readCache() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return { items: [], revision: 0, dirty: false };
      const source = Array.isArray(saved) ? saved : saved.items;
      return {
        items: normalizeItems(source),
        revision: Number(Array.isArray(saved) ? 0 : saved.revision || 0),
        dirty: !Array.isArray(saved) && saved.dirty === true,
      };
    } catch {
      return { items: [], revision: 0, dirty: false };
    }
  }

  function normalizeItems(source) {
    if (!Array.isArray(source)) return [];
    const seen = new Set();
    return source.slice(0, maxItems).filter((item) => item && item.title && item.url).map((item) => ({
      id: String(item.id || makeId()),
      title: String(item.title).trim().slice(0, 80),
      url: normalizeUrl(String(item.url).trim()).slice(0, 2000),
      updatedAt: item.updatedAt || new Date().toISOString(),
    })).filter((item) => {
      if (!item.title || !item.url || seen.has(item.id)) return false;
      try {
        const parsed = new URL(item.url);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return false;
      } catch {
        return false;
      }
      seen.add(item.id);
      return true;
    });
  }

  function saveLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ revision, dirty, items }));
  }

  function makeId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function normalizeUrl(value) {
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  }

  function getDomain(value) {
    try { return new URL(normalizeUrl(value)).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function iconFor(item) { return (item.title || '✦').trim().slice(0, 1).toUpperCase(); }

  function faviconSources(item) {
    try {
      const url = new URL(item.url);
      return [
        `${url.origin}/favicon.ico`,
        `${url.origin}/favicon.png`,
        `${url.origin}/favicon.svg`,
        `${url.origin}/apple-touch-icon.png`,
      ];
    } catch { return []; }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function iconMarkup(item) {
    const sources = faviconSources(item);
    if (!sources.length) return escapeHtml(iconFor(item));
    return `<img src="${escapeHtml(sources[0])}" data-next="${escapeHtml(sources.slice(1).join('|'))}" data-letter="${escapeHtml(iconFor(item))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="shortcutIconError(this)">`;
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

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function updateStatus(message = '') {
    if (!dataStatus) return;
    dataStatus.textContent = message || (dirty
      ? '本机有未导出的修改 · 请点击“导出”更新 shortcuts.json'
      : '数据来自 shortcuts.json · 编辑仅保存到当前浏览器');
    dataStatus.classList.toggle('pending', dirty);
  }

  async function loadData() {
    try {
      const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`GET ${response.status}`);
      const remote = await response.json();
      if (!dirty) {
        items = normalizeItems(Array.isArray(remote) ? remote : remote.items);
        revision = Number(Array.isArray(remote) ? 0 : remote.revision || 0);
        saveLocal();
        render();
      }
      updateStatus();
    } catch {
      updateStatus(items.length ? '无法读取 shortcuts.json · 当前显示本机缓存' : '无法读取 shortcuts.json · 请使用本地服务器打开页面');
      if (!items.length) showToast('无法读取 shortcuts.json');
    }
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
      const clearLongPress = () => clearTimeout(longPressTimer);

      card.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'touch') return;
        card.setPointerCapture?.(event.pointerId);
        longPressTriggered = false;
        touchDragging = false;
        touchMoved = false;
        if (moveModeId === card.dataset.id) {
          longPressTriggered = true;
          touchDragging = true;
          card.classList.add('dragging');
          return;
        }
        longPressTimer = setTimeout(() => {
          card.classList.add('show-actions');
          longPressTriggered = true;
          if (navigator.vibrate) navigator.vibrate(25);
          openCardMenu(card);
        }, 550);
      });
      card.addEventListener('pointermove', (event) => {
        if (event.pointerType !== 'touch' || !touchDragging) return;
        event.preventDefault();
        touchMoved = true;
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.shortcut[data-id]');
        if (!target || target === card || target.parentElement !== grid) return;
        const rect = target.getBoundingClientRect();
        if (event.clientY > rect.top + rect.height / 2) grid.insertBefore(card, target.nextSibling);
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
        }
        moveModeId = '';
        card.classList.remove('move-mode', 'show-actions');
      });
      card.addEventListener('pointercancel', () => {
        touchDragging = false;
        moveModeId = '';
        card.classList.remove('dragging', 'move-mode', 'show-actions');
      });
      card.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); openCardMenu(card); });
      card.addEventListener('click', (event) => {
        if (longPressTriggered) {
          event.preventDefault();
          event.stopPropagation();
          longPressTriggered = false;
          return;
        }
        if (moveModeId === card.dataset.id) {
          event.preventDefault();
          event.stopPropagation();
        }
      }, true);
      card.addEventListener('dragstart', () => { draggedId = card.dataset.id; card.classList.add('dragging'); });
      card.addEventListener('dragend', () => { draggedId = ''; moveModeId = ''; card.classList.remove('dragging', 'move-mode'); });
      card.addEventListener('dragover', (event) => event.preventDefault());
      card.addEventListener('drop', (event) => { event.preventDefault(); reorder(draggedId, card.dataset.id); });
    });
    updateStatus();
  }

  function cardTemplate(item) {
    return `<article class="shortcut" data-id="${escapeHtml(item.id)}" draggable="true">
      <a class="shortcut-link" href="${escapeHtml(item.url)}">
        <span class="shortcut-icon">${iconMarkup(item)}</span>
        <div class="shortcut-name">${escapeHtml(item.title)}</div>
        <div class="shortcut-url">${escapeHtml(getDomain(item.url))}</div>
      </a>
      <button class="shortcut-more" data-action="menu" data-id="${escapeHtml(item.id)}" type="button" aria-label="编辑或删除">⋮</button>
    </article>`;
  }

  function changed(message) {
    items = normalizeItems(items);
    dirty = true;
    revision += 1;
    saveLocal();
    render();
    showToast(`${message} · 请导出 JSON 保存到仓库`);
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
    if (existing) {
      existing.title = title;
      existing.url = url;
      existing.updatedAt = new Date().toISOString();
    } else {
      items.push({ id: makeId(), title, url, updatedAt: new Date().toISOString() });
    }
    dialog.close();
    changed(existing ? '已更新' : '已添加');
  }

  function openCardMenu(anchor) {
    activeMenuId = anchor.dataset.id;
    const rect = anchor.getBoundingClientRect();
    cardMenu.hidden = false;
    cardMenu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 140))}px`;
    cardMenu.style.left = `${Math.max(8, Math.min(rect.right - 120, window.innerWidth - 135))}px`;
  }

  function closeMenu() {
    cardMenu.hidden = true;
    grid.querySelectorAll('.show-actions').forEach((card) => card.classList.remove('show-actions'));
  }

  function reorder(fromId, toId) {
    if (!fromId || fromId === toId) return;
    const from = items.findIndex((item) => item.id === fromId);
    const to = items.findIndex((item) => item.id === toId);
    if (from < 0 || to < 0) return;
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    changed('顺序已保存');
  }

  function exportItems() {
    const payload = { revision, updatedAt: new Date().toISOString(), items };
    const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'shortcuts.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    showToast('已导出 shortcuts.json，请提交到 GitHub');
    updateStatus('已生成 shortcuts.json · 用它覆盖仓库文件后提交 GitHub');
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
        items = normalizeItems(source);
        changed(`已导入 ${items.length} 个快捷方式`);
      } catch {
        showToast('导入文件格式不正确');
      }
      event.target.value = '';
    };
    reader.readAsText(file);
  }

  form.addEventListener('submit', save);
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
  document.querySelector('#moveButton').addEventListener('click', () => {
    const card = grid.querySelector(`.shortcut[data-id="${CSS.escape(activeMenuId)}"]`);
    closeMenu();
    moveModeId = activeMenuId;
    card?.classList.add('move-mode');
    showToast('请拖动当前快捷方式调整位置');
  });
  document.querySelector('#deleteButton').addEventListener('click', () => {
    const item = items.find((entry) => entry.id === activeMenuId);
    closeMenu();
    if (item && confirm(`删除“${item.title}”？`)) {
      items = items.filter((entry) => entry.id !== activeMenuId);
      changed('已删除');
    }
  });
  document.querySelector('#exportButton').addEventListener('click', exportItems);
  document.querySelector('#importButton').addEventListener('click', () => document.querySelector('#importInput').click());
  document.querySelector('#importInput').addEventListener('change', importItems);
  document.addEventListener('click', closeMenu);

  render();
  loadData();
})();
