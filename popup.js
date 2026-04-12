// State
let tagsData = {};
let domainAliases = {};  // domain -> custom display name
let settings = { useSiteName: false, dedupe: 'none' };
let selectedTag = null;
let currentPageInfo = null;

// Init
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['tags', 'domainAliases', 'settings'], data => {
    tagsData = data.tags || {};
    domainAliases = data.domainAliases || {};
    settings = data.settings || { useSiteName: false, dedupe: 'none' };
    initTabs();
    initHistory();
    initTags();
    initModal();
    initSettings();
  });
});

// === Tabs ===
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      document.getElementById('history-view').style.display = name === 'history' ? '' : 'none';
      document.getElementById('tags-view').style.display = name === 'tags' ? '' : 'none';
      document.getElementById('history-toolbar').style.display = name === 'history' ? '' : 'none';
      document.getElementById('tags-toolbar').style.display = name === 'tags' ? '' : 'none';
    });
  });
}

// === History ===
function initHistory() {
  loadHistory(7);
  document.getElementById('time-range').addEventListener('change', e => {
    loadHistory(parseInt(e.target.value));
  });
}

function loadHistory(days) {
  const container = document.getElementById('history-tree');
  container.innerHTML = '<div class="empty">加载中...</div>';
  // Use midnight of today as end time for "today"; otherwise now
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startTime = days <= 1 ? todayStart : Date.now() - days * 24 * 60 * 60 * 1000;
  const maxResults = days <= 1 ? 2000 : days <= 7 ? 5000 : 20000;
  try {
    chrome.history.search({ text: '', startTime, maxResults }, items => {
      if (chrome.runtime.lastError) {
        container.innerHTML = '<div class="empty">读取失败: ' + esc(chrome.runtime.lastError.message) + '</div>';
        return;
      }
      renderHistoryTree(groupByDomain(items), items.length >= maxResults);
    });
  } catch (e) {
    container.innerHTML = '<div class="empty">读取失败: ' + esc(e.message) + '</div>';
  }
}

function getMainDomain(url) {
  try {
    const h = new URL(url).hostname;
    const parts = h.split('.');
    if (parts.length <= 2) return h;
    const multiTLDs = ['co.uk','com.cn','com.au','co.jp','org.cn','net.cn','com.hk','com.tw','com.br','co.in','ac.uk','gov.uk'];
    for (const tld of multiTLDs) {
      if (h.endsWith('.' + tld)) return parts.slice(-(tld.split('.').length + 1)).join('.');
    }
    return parts.slice(-2).join('.');
  } catch { return url; }
}

function extractSiteName(title) {
  if (!title) return '';
  // Common patterns: "Title - SiteName", "Title | SiteName", "Title — SiteName", "Title · SiteName"
  const separators = [' - ', ' | ', ' — ', ' – ', ' · '];
  for (const sep of separators) {
    const idx = title.lastIndexOf(sep);
    if (idx > 0) {
      const candidate = title.substring(idx + sep.length).trim();
      if (candidate.length > 0 && candidate.length < 40) return candidate;
    }
  }
  return '';
}

function dedupeItems(items) {
  if (settings.dedupe === 'none') return items;
  const seen = new Set();
  return items.filter(item => {
    let key;
    if (settings.dedupe === 'url') {
      key = item.url;
    } else {
      key = (item.title || '').trim();
      if (!key) key = item.url;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getDomainDisplayName(domain, items) {
  // 1. User custom alias
  if (domainAliases[domain]) return domainAliases[domain];
  // 2. Site name from settings
  if (settings.useSiteName) {
    for (const item of items) {
      const sn = extractSiteName(item.title);
      if (sn) return sn;
    }
  }
  return domain;
}

function groupByDomain(items) {
  items = dedupeItems(items);
  const groups = {};
  items.forEach(item => {
    if (!item.url || item.url.startsWith('chrome') || item.url.startsWith('about:')) return;
    const d = getMainDomain(item.url);
    if (!groups[d]) groups[d] = [];
    groups[d].push(item);
  });
  Object.values(groups).forEach(g => g.sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0)));
  return Object.entries(groups)
    .sort((a, b) => (b[1][0]?.lastVisitTime || 0) - (a[1][0]?.lastVisitTime || 0))
    .map(([domain, items]) => ({ domain, items }));
}

function renderHistoryTree(groups, mayBeTruncated) {
  const container = document.getElementById('history-tree');
  container.innerHTML = '';
  if (!groups.length) { container.innerHTML = '<div class="empty">暂无浏览记录</div>'; return; }

  const total = groups.reduce((s, g) => s + g.items.length, 0);
  const root = el('div', 'tree-root');
  const rootNode = el('div', 'tree-node root-node');
  rootNode.innerHTML = '<span class="node-label">浏览历史</span><span class="node-count">' + total + (mayBeTruncated ? '+' : '') + '</span>';
  root.appendChild(rootNode);
  const children = el('div', 'tree-children');
  groups.forEach(g => children.appendChild(makeDomainBranch(g)));
  root.appendChild(children);
  if (mayBeTruncated) {
    const tip = el('div', 'empty');
    tip.style.padding = '6px';
    tip.style.fontSize = '11px';
    tip.textContent = '实际记录可能更多，已显示 ' + total + ' 条';
    root.appendChild(tip);
  }
  container.appendChild(root);
}

function makeDomainBranch(group) {
  const branch = el('div', 'tree-branch');
  const node = el('div', 'tree-node domain-node');
  const count = group.items.length;
  const display = getDomainDisplayName(group.domain, group.items);
  node.innerHTML =
    '<span class="toggle">\u25B6</span>' +
    '<span class="node-label" title="' + esc(group.domain) + '">' + esc(display) + '</span>' +
    '<span class="node-meta">' + count + '条 \u00B7 ' + fmtTime(group.items[0]?.lastVisitTime) + '</span>' +
    '<span class="edit-domain" title="编辑名称">\u270E</span>';
  const childBox = el('div', 'tree-children collapsed');
  let rendered = false;

  // Edit domain display name
  node.querySelector('.edit-domain').addEventListener('click', e => {
    e.stopPropagation();
    openEditDomainModal(group.domain);
  });

  node.addEventListener('click', e => {
    if (e.target.classList.contains('edit-domain')) return;
    if (childBox.classList.contains('collapsed') && !rendered) {
      const limit = 30;
      group.items.slice(0, limit).forEach(item => {
        const leaf = el('div', 'tree-node leaf-node');
        leaf.innerHTML =
          '<span class="node-label" title="' + esc(item.url) + '">' + esc(item.title || '无标题') + '</span>' +
          '<span class="node-time">' + fmtTime(item.lastVisitTime) + '</span>';
        leaf.addEventListener('click', ev => { ev.stopPropagation(); chrome.tabs.create({ url: item.url }); });
        childBox.appendChild(el('div', 'tree-branch')).appendChild(leaf);
      });
      if (count > limit) {
        const moreBranch = el('div', 'tree-branch');
        const moreLink = el('span', 'show-more');
        moreLink.textContent = '还有 ' + (count - limit) + ' 条，点击展开';
        let moreLoaded = false;
        moreLink.addEventListener('click', e => {
          e.stopPropagation();
          if (moreLoaded) return;
          moreLoaded = true;
          group.items.slice(limit).forEach(item => {
            const leaf = el('div', 'tree-node leaf-node');
            leaf.innerHTML =
              '<span class="node-label" title="' + esc(item.url) + '">' + esc(item.title || '无标题') + '</span>' +
              '<span class="node-time">' + fmtTime(item.lastVisitTime) + '</span>';
            leaf.addEventListener('click', ev => { ev.stopPropagation(); chrome.tabs.create({ url: item.url }); });
            childBox.appendChild(el('div', 'tree-branch')).appendChild(leaf);
          });
          moreBranch.remove();
        });
        moreBranch.appendChild(moreLink);
        childBox.appendChild(moreBranch);
      }
      rendered = true;
    }
    childBox.classList.toggle('collapsed');
    node.querySelector('.toggle').textContent = childBox.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
  });
  branch.appendChild(node);
  branch.appendChild(childBox);
  return branch;
}

// === Edit Domain Name Modal ===
let editingDomain = null;

function openEditDomainModal(domain) {
  editingDomain = domain;
  document.getElementById('edit-domain-original').textContent = domain;
  const input = document.getElementById('edit-domain-name');
  input.value = domainAliases[domain] || '';
  input.placeholder = domain;
  document.getElementById('edit-domain-modal').style.display = '';
  input.focus();
  input.select();
}

function initEditDomainModal() {
  const save = () => {
    const name = document.getElementById('edit-domain-name').value.trim();
    if (name && name !== editingDomain) {
      domainAliases[editingDomain] = name;
    } else {
      delete domainAliases[editingDomain];
    }
    chrome.storage.local.set({ domainAliases });
    document.getElementById('edit-domain-modal').style.display = 'none';
    // Reload current view
    const days = parseInt(document.getElementById('time-range').value);
    loadHistory(days);
  };

  document.getElementById('save-domain-name').addEventListener('click', save);
  document.getElementById('edit-domain-name').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  document.getElementById('reset-domain-name').addEventListener('click', () => {
    if (editingDomain) {
      delete domainAliases[editingDomain];
      chrome.storage.local.set({ domainAliases });
    }
    document.getElementById('edit-domain-modal').style.display = 'none';
    const days = parseInt(document.getElementById('time-range').value);
    loadHistory(days);
  });
  document.getElementById('cancel-edit-domain').addEventListener('click', () => {
    document.getElementById('edit-domain-modal').style.display = 'none';
  });
}

// === Settings ===
function initSettings() {
  // Apply current settings to UI
  document.getElementById('use-site-name').checked = settings.useSiteName;
  const radios = document.querySelectorAll('input[name="dedupe"]');
  radios.forEach(r => { r.checked = r.value === settings.dedupe; });

  document.getElementById('settings-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = '';
  });

  document.getElementById('save-settings').addEventListener('click', () => {
    settings.useSiteName = document.getElementById('use-site-name').checked;
    const checked = document.querySelector('input[name="dedupe"]:checked');
    settings.dedupe = checked ? checked.value : 'none';
    chrome.storage.local.set({ settings });
    document.getElementById('settings-modal').style.display = 'none';
    // Reload
    const days = parseInt(document.getElementById('time-range').value);
    loadHistory(days);
  });

  initEditDomainModal();
}

// === Tags ===
function initTags() {
  renderTagsTree();
  document.getElementById('add-page-btn').addEventListener('click', openTagModal);
}

function renderTagsTree() {
  const container = document.getElementById('tags-tree');
  container.innerHTML = '';
  const names = Object.keys(tagsData);
  if (!names.length) {
    container.innerHTML = '<div class="empty">暂无标签<br>点击上方按钮添加当前页面</div>';
    return;
  }
  const root = el('div', 'tree-root');
  const rootNode = el('div', 'tree-node root-node tag-root');
  rootNode.innerHTML = '<span class="node-label">我的标签</span><span class="node-count">' + names.length + '</span>';
  root.appendChild(rootNode);
  const children = el('div', 'tree-children');
  names.forEach(name => children.appendChild(makeTagBranch(name, tagsData[name])));
  root.appendChild(children);
  container.appendChild(root);
}

function makeTagBranch(tagName, items) {
  const branch = el('div', 'tree-branch');
  const node = el('div', 'tree-node domain-node tag-node');
  node.innerHTML =
    '<span class="toggle">\u25B6</span>' +
    '<span class="node-label">' + esc(tagName) + '</span>' +
    '<span class="node-meta">' + items.length + '条</span>' +
    '<span class="delete-tag" title="删除标签">\u2715</span>';

  node.querySelector('.delete-tag').addEventListener('click', e => {
    e.stopPropagation();
    if (confirm('确定删除标签"' + tagName + '"？')) {
      delete tagsData[tagName];
      saveTags();
      renderTagsTree();
    }
  });

  const childBox = el('div', 'tree-children collapsed');
  let rendered = false;

  node.addEventListener('click', e => {
    if (e.target.classList.contains('delete-tag')) return;
    if (childBox.classList.contains('collapsed') && !rendered) {
      items.forEach((item, i) => {
        const leaf = el('div', 'tree-node leaf-node');
        leaf.innerHTML =
          '<span class="node-label" title="' + esc(item.url) + '">' + esc(item.displayTitle || item.title || '无标题') + '</span>' +
          '<span class="node-time">' + fmtTime(item.addedAt) + '</span>' +
          '<span class="delete-item" data-idx="' + i + '" title="删除">\u2715</span>';
        leaf.addEventListener('click', ev => {
          if (ev.target.classList.contains('delete-item')) {
            ev.stopPropagation();
            items.splice(parseInt(ev.target.dataset.idx), 1);
            if (!items.length) delete tagsData[tagName];
            saveTags();
            renderTagsTree();
            return;
          }
          ev.stopPropagation();
          chrome.tabs.create({ url: item.url });
        });
        childBox.appendChild(el('div', 'tree-branch')).appendChild(leaf);
      });
      rendered = true;
    }
    childBox.classList.toggle('collapsed');
    node.querySelector('.toggle').textContent = childBox.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
  });

  branch.appendChild(node);
  branch.appendChild(childBox);
  return branch;
}

// === Tag Modal ===
function openTagModal() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0] || !tabs[0].url || tabs[0].url.startsWith('chrome')) return;
    currentPageInfo = { url: tabs[0].url, title: tabs[0].title || '' };

    const nameInput = document.getElementById('display-name');
    nameInput.value = '';
    nameInput.placeholder = currentPageInfo.title || '无标题';

    const tagList = document.getElementById('tag-list');
    tagList.innerHTML = '';
    selectedTag = null;

    Object.keys(tagsData).forEach(name => {
      const opt = el('div', 'tag-option');
      opt.textContent = name;
      opt.addEventListener('click', () => {
        tagList.querySelectorAll('.tag-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        selectedTag = name;
        document.getElementById('new-tag-name').value = '';
      });
      tagList.appendChild(opt);
    });

    document.getElementById('new-tag-name').value = '';
    document.getElementById('tag-modal').style.display = '';
    nameInput.focus();
  });
}

function initModal() {
  document.getElementById('new-tag-name').addEventListener('input', e => {
    if (e.target.value.trim()) {
      document.querySelectorAll('.tag-option').forEach(o => o.classList.remove('selected'));
      selectedTag = null;
    }
  });

  const confirm = () => {
    const newTag = document.getElementById('new-tag-name').value.trim();
    const displayName = document.getElementById('display-name').value.trim() || currentPageInfo.title || '';
    let tag = newTag || selectedTag;
    if (!tag) return;
    if (!tagsData[tag]) tagsData[tag] = [];
    tagsData[tag].push({
      url: currentPageInfo.url,
      title: currentPageInfo.title,
      displayTitle: displayName,
      addedAt: Date.now()
    });
    saveTags();
    renderTagsTree();
    document.getElementById('tag-modal').style.display = 'none';
  };

  document.getElementById('confirm-add').addEventListener('click', confirm);
  document.getElementById('display-name').addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); });
  document.getElementById('cancel-add').addEventListener('click', () => {
    document.getElementById('tag-modal').style.display = 'none';
  });
}

function saveTags() {
  chrome.storage.local.set({ tags: tagsData });
}

// === Utils ===
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function fmtTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + '分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '小时前';
  const d = Math.floor(h / 24);
  if (d < 30) return d + '天前';
  const dt = new Date(ts);
  return (dt.getMonth() + 1) + '/' + dt.getDate();
}
