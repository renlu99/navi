(() => {
  'use strict';

  const DATA_URL = './shortcuts.json';
  const ICONS_DIR = './icons/';
  const ICON_MANIFEST_URL = './icon-manifest.json';
  const STORAGE_KEY = 'chrome-like-shortcuts-static-v1';
  const GITHUB_CONFIG_KEY = 'navi-github-config-v1';
  const GITHUB_API = 'https://api.github.com';
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
  const githubDialog = document.querySelector('#githubDialog');
  const githubForm = document.querySelector('#githubForm');
  const githubButton = document.querySelector('#githubButton');
  const closeGithubDialogButton = document.querySelector('#closeGithubDialogButton');
  const cancelGithubDialogButton = document.querySelector('#cancelGithubDialogButton');
  const clearGithubButton = document.querySelector('#clearGithubButton');
  const githubOwnerInput = document.querySelector('#githubOwnerInput');
  const githubRepoInput = document.querySelector('#githubRepoInput');
  const githubBranchInput = document.querySelector('#githubBranchInput');
  const githubPathInput = document.querySelector('#githubPathInput');
  const githubTokenInput = document.querySelector('#githubTokenInput');
  const githubError = document.querySelector('#githubError');
  let cached = readCache();
  let items = cached.items;
  let revision = cached.revision;
  let dirty = cached.dirty;
  let github = readGithubConfig();
  let hostedIcons = {};
  let remoteSha = '';
  let syncing = false;
  let lastPollAt = 0;
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

  function readGithubConfig() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(GITHUB_CONFIG_KEY) || '{}'); } catch { /* 使用默认配置 */ }
    const pathParts = location.pathname.split('/').filter(Boolean);
    const inferredOwner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '';
    const inferredRepo = location.hostname.endsWith('.github.io') ? (pathParts[0] || '') : '';
    return {
      owner: String(saved.owner || inferredOwner).trim(),
      repo: String(saved.repo || inferredRepo).trim(),
      branch: String(saved.branch || 'main').trim(),
      path: String(saved.path || 'shortcuts.json').trim(),
      token: String(saved.token || '').trim(),
    };
  }

  function hasGithubRepo() { return Boolean(github.owner && github.repo && github.branch && github.path); }

  function githubFileUrl() {
    return `${GITHUB_API}/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repo)}/contents/${github.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(github.branch)}&t=${Date.now()}`;
  }

  function githubHeaders() {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (github.token) headers.Authorization = `Bearer ${github.token}`;
    return headers;
  }

  function encodeBase64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function decodeBase64(value) {
    const binary = atob(String(value).replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function githubResponse(url, options = {}) {
    const response = await fetch(url, { ...options, cache: 'no-store', headers: { ...githubHeaders(), ...(options.headers || {}) } });
    let payload = null;
    try { payload = await response.json(); } catch { /* 非 JSON 响应 */ }
    if (!response.ok) {
      const message = payload?.message || `GitHub API ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function readGithubFile() {
    if (!hasGithubRepo()) throw new Error('请先配置 GitHub 仓库');
    const payload = await githubResponse(githubFileUrl());
    if (payload.type !== 'file' || !payload.content) throw new Error('GitHub 文件不是普通 JSON 文件');
    let document;
    try { document = JSON.parse(decodeBase64(payload.content)); } catch { throw new Error('GitHub 上的 shortcuts.json 格式不正确'); }
    return {
      sha: payload.sha,
      revision: Number(Array.isArray(document) ? 0 : document.revision || 0),
      items: normalizeItems(Array.isArray(document) ? document : document.items),
    };
  }

  function githubPayload() {
    return { revision, updatedAt: new Date().toISOString(), items };
  }

  async function writeGithubFile() {
    const latest = await readGithubFile();
    const body = {
      message: `更新快捷方式 ${new Date().toISOString().slice(0, 10)}`,
      content: encodeBase64(`${JSON.stringify(githubPayload(), null, 2)}\n`),
      sha: latest.sha,
      branch: github.branch,
    };
    const payload = await githubResponse(githubFileUrl().split('?')[0], {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    remoteSha = payload.content?.sha || latest.sha;
  }

  function normalizeItems(source) {
    if (!Array.isArray(source)) return [];
    const seen = new Set();
    return source.slice(0, maxItems).filter((item) => item && item.title && item.url).map((item) => ({
      id: String(item.id || makeId()),
      title: String(item.title).trim().slice(0, 80),
      url: normalizeUrl(String(item.url).trim()).slice(0, 2000),
      icon: normalizeIconPath(item.icon),
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

  function normalizeIconPath(value) {
    const icon = String(value || '').trim().replace(/^\.\//, '');
    return /^icons\/[A-Za-z0-9._-]+$/.test(icon) ? icon : '';
  }

  function iconFor(item) { return (item.title || '✦').trim().slice(0, 1).toUpperCase(); }

  function iconSources(item) {
    const iconPath = normalizeIconPath(item.icon) || normalizeIconPath(hostedIcons[item.id]);
    const hosted = iconPath ? `${ICONS_DIR}${encodeURIComponent(iconPath.slice('icons/'.length))}` : '';
    // 浏览器只读取本站已经托管的图标；没有托管图标时由 iconMarkup 返回名称首字母。
    return hosted ? [hosted] : [];
  }

  async function loadIconManifest() {
    try {
      const response = await fetch(`${ICON_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const manifest = await response.json();
      hostedIcons = Object.fromEntries(Object.entries(manifest || {}).map(([id, entry]) => [
        id,
        typeof entry === 'string' ? entry : entry?.path,
      ]).filter(([, path]) => normalizeIconPath(path)));
      render();
    } catch {
      // 没有图标清单时继续使用快捷方式名称首字母。
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function iconMarkup(item) {
    const sources = iconSources(item);
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
    dataStatus.textContent = message || (syncing
      ? '正在同步到 GitHub…'
      : dirty
        ? (github.token ? '本机有未同步修改 · 正在写回 GitHub' : '本机有未同步修改 · 请配置 GitHub Token')
        : (hasGithubRepo() ? `数据来自 GitHub · ${github.owner}/${github.repo}/${github.path}` : '数据来自 shortcuts.json · 编辑仅保存到当前浏览器'));
    dataStatus.classList.toggle('pending', dirty || syncing);
  }

  async function loadData(force = false) {
    if (dirty && !force) {
      updateStatus();
      return;
    }
    try {
      if (hasGithubRepo()) {
        const remote = await readGithubFile();
        if (!force && remote.sha === remoteSha) {
          updateStatus();
          return;
        }
        items = remote.items;
        revision = remote.revision;
        remoteSha = remote.sha;
        dirty = false;
        saveLocal();
        render();
        updateStatus('已读取 GitHub shortcuts.json');
        return;
      }
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
    } catch (error) {
      updateStatus(items.length ? `无法读取 GitHub 数据 · 当前显示本机缓存（${error.message}）` : `无法读取数据（${error.message}）`);
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
      let touchStartX = 0;
      let touchStartY = 0;
      const clearLongPress = () => clearTimeout(longPressTimer);

      card.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'touch') return;
        longPressTriggered = false;
        touchDragging = false;
        touchMoved = false;
        touchStartX = event.clientX;
        touchStartY = event.clientY;
        if (moveModeId === card.dataset.id) {
          longPressTriggered = true;
          touchDragging = true;
          card.classList.add('dragging');
          card.setPointerCapture?.(event.pointerId);
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
        if (event.pointerType !== 'touch') return;
        if (!touchDragging) {
          if (Math.hypot(event.clientX - touchStartX, event.clientY - touchStartY) > 8) clearLongPress();
          return;
        }
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
    showToast(github.token ? `${message} · 正在同步 GitHub` : `${message} · 请配置 GitHub Token`);
    syncGithub();
  }

  async function syncGithub() {
    if (!dirty || syncing || !github.token || !hasGithubRepo()) return;
    syncing = true;
    updateStatus();
    try {
      await writeGithubFile();
      dirty = false;
      saveLocal();
      render();
      showToast('已同步到 GitHub');
      updateStatus('已同步到 GitHub shortcuts.json');
    } catch (error) {
      updateStatus(`GitHub 同步失败：${error.message}`);
      showToast('GitHub 同步失败，请检查配置');
    } finally {
      syncing = false;
      updateStatus();
    }
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
      existing.icon = '';
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
    showToast('已导出 shortcuts.json');
    updateStatus(github.token ? '已导出本地备份 · GitHub 同步仍由页面自动完成' : '已导出 shortcuts.json · 配置 GitHub 后可自动同步');
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

  function openGithubDialog() {
    githubOwnerInput.value = github.owner;
    githubRepoInput.value = github.repo;
    githubBranchInput.value = github.branch;
    githubPathInput.value = github.path;
    githubTokenInput.value = '';
    githubError.textContent = '';
    githubDialog.showModal();
    setTimeout(() => (githubTokenInput.value ? githubTokenInput : githubOwnerInput).focus(), 40);
  }

  githubButton.addEventListener('click', (event) => { event.stopPropagation(); openGithubDialog(); });
  closeGithubDialogButton.addEventListener('click', () => githubDialog.close());
  cancelGithubDialogButton.addEventListener('click', () => githubDialog.close());
  githubDialog.addEventListener('click', (event) => { if (event.target === githubDialog) githubDialog.close(); });
  clearGithubButton.addEventListener('click', () => {
    github.token = '';
    localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify(github));
    githubTokenInput.value = '';
    githubError.textContent = 'Token 已从当前设备清除。';
    updateStatus();
  });
  githubForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    githubError.textContent = '';
    const next = {
      owner: githubOwnerInput.value.trim(),
      repo: githubRepoInput.value.trim(),
      branch: githubBranchInput.value.trim(),
      path: githubPathInput.value.trim(),
      token: githubTokenInput.value.trim() || github.token,
    };
    if (!next.owner || !next.repo || !next.branch || !next.path) {
      githubError.textContent = '请完整填写仓库信息。';
      return;
    }
    github = next;
    localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify(github));
    githubDialog.close();
    if (dirty && github.token) {
      syncGithub();
    } else {
      await loadData(true);
    }
  });

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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastPollAt = 0;
      pollGithub();
    }
  });
  window.addEventListener('online', () => {
    lastPollAt = 0;
    pollGithub();
  });

  function pollGithub() {
    if (document.hidden || dirty || syncing || !hasGithubRepo()) return;
    const interval = github.token ? 1000 : 60000;
    if (Date.now() - lastPollAt < interval) return;
    lastPollAt = Date.now();
    loadData();
  }

  setInterval(pollGithub, 1000);

  render();
  loadIconManifest();
  if (dirty && github.token) syncGithub();
  else loadData();
})();
