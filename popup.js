// State
let tagsData = {};
let domainAliases = {};
let domainGroups = {};     // domain -> groupName
let domainStars = {};      // domain -> true
let urlStars = {};         // url -> true
let tagStars = {};         // "tag|url" -> true
let settings = { useSiteName: false, dedupe: 'none', showFavicon: false, enableGroups: false, enableStar: false };
let selectedTag = null;
let currentPageInfo = null;
let allGroups = [];        // cached group names
let rawHistoryItems = [];  // cached raw items for re-render
let editingDomain = null;
let editingTagItem = null;  // { tag, index }

// Init
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['tags', 'domainAliases', 'domainGroups', 'domainStars', 'urlStars', 'tagStars', 'settings', 'quickAddPage'], data => {
    tagsData = data.tags || {};
    domainAliases = data.domainAliases || {};
    domainGroups = data.domainGroups || {};
    domainStars = data.domainStars || {};
    urlStars = data.urlStars || {};
    tagStars = data.tagStars || {};
    settings = data.settings || settings;
    initTabs();
    initHistory();
    initTags();
    initModal();
    initSettings();
    initEditDomainModal();
    initEditTagItemModal();
    initQuickAdd();
    initExport();
    // Check if opened via keyboard shortcut
    if (data.quickAddPage && Date.now() - data.quickAddPage.ts < 5000) {
      currentPageInfo = data.quickAddPage;
      chrome.storage.local.remove('quickAddPage');
      openQuickAddModal();
    }
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
  document.getElementById('time-range').addEventListener('change', () => reloadHistory());
  document.getElementById('filter-group').addEventListener('change', () => renderCachedHistory());
  document.getElementById('filter-star').addEventListener('change', () => renderCachedHistory());
}

function reloadHistory() {
  const days = parseInt(document.getElementById('time-range').value);
  loadHistory(days);
}

function loadHistory(days) {
  const container = document.getElementById('history-tree');
  container.innerHTML = '<div class="empty">加载中...</div>';
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startTime = days <= 0 ? 0 : days <= 1 ? todayStart : Date.now() - days * 24 * 60 * 60 * 1000;
  const maxResults = days <= 0 ? 50000 : days <= 1 ? 2000 : days <= 7 ? 5000 : 20000;
  try {
    chrome.history.search({ text: '', startTime, maxResults }, items => {
      if (chrome.runtime.lastError) {
        container.innerHTML = '<div class="empty">读取失败: ' + esc(chrome.runtime.lastError.message) + '</div>';
        return;
      }
      rawHistoryItems = items;
      renderCachedHistory();
    });
  } catch (e) {
    container.innerHTML = '<div class="empty">读取失败: ' + esc(e.message) + '</div>';
  }
}

function renderCachedHistory() {
  const items = dedupeItems(rawHistoryItems);
  const groups = groupByDomain(items);
  const filtered = applyFilters(groups);
  renderHistoryTree(filtered, rawHistoryItems.length >= 50000);
  updateGroupFilter(groups);
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

let faviconMap = {};  // domain -> favicon url

function loadFavicons() {
  const domainUrlMap = {};
  rawHistoryItems.forEach(item => {
    if (!item.url) return;
    const d = getMainDomain(item.url);
    if (!domainUrlMap[d]) domainUrlMap[d] = item.url;
  });
  document.querySelectorAll('img[data-fav-domain]').forEach(img => {
    const d = img.dataset.favDomain;
    const pageUrl = domainUrlMap[d] || ('https://' + d);
    // Build Google favicon API URL — works everywhere, no special permissions needed
    const favUrl = 'https://www.google.com/s2/favicons?sz=32&domain_url=' + encodeURIComponent(pageUrl);
    img.onerror = function() { this.style.display = 'none'; };
    img.src = favUrl;
  });
}

function extractSiteName(title) {
  if (!title) return '';
  const seps = [' - ', ' | ', ' — ', ' – ', ' · '];
  for (const s of seps) {
    const i = title.lastIndexOf(s);
    if (i > 0) {
      const c = title.substring(i + s.length).trim();
      if (c.length > 0 && c.length < 40) return c;
    }
  }
  return '';
}

function dedupeItems(items) {
  if (settings.dedupe === 'none') return items;
  const seen = new Set();
  return items.filter(item => {
    const key = settings.dedupe === 'url' ? item.url : ((item.title || '').trim() || item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getDomainDisplayName(domain) {
  if (domainAliases[domain]) return domainAliases[domain];
  return domain;
}

function groupByDomain(items) {
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

function applyFilters(groups) {
  const filterGroup = document.getElementById('filter-group').value;
  const filterStar = document.getElementById('filter-star').value;
  return groups.filter(g => {
    // Group filter: "all" = show everything, "grouped" = only grouped domains, else specific group
    if (filterGroup === 'grouped') {
      if (!domainGroups[g.domain]) return false;
    } else if (filterGroup !== 'all') {
      if ((domainGroups[g.domain] || '') !== filterGroup) return false;
    }
    if (filterStar === 'starred') {
      if (domainStars[g.domain]) return true;
      if (g.items.some(item => urlStars[item.url])) return true;
      return false;
    }
    return true;
  });
}

function updateGroupFilter(groups) {
  const sel = document.getElementById('filter-group');
  const cur = sel.value;
  allGroups = [...new Set(Object.values(domainGroups).filter(Boolean))].sort();
  sel.innerHTML = '<option value="all">全部</option><option value="grouped">有分组的</option>';
  allGroups.forEach(g => {
    const o = document.createElement('option');
    o.value = g; o.textContent = g;
    sel.appendChild(o);
  });
  sel.value = cur;
  sel.style.display = settings.enableGroups ? '' : 'none';
  document.getElementById('filter-star').style.display = settings.enableStar ? '' : 'none';
}

function renderHistoryTree(groups, mayBeTruncated) {
  const container = document.getElementById('history-tree');
  container.innerHTML = '';
  if (!groups.length) { container.innerHTML = '<div class="empty">暂无浏览记录</div>'; return; }

  // Apply site name setting for display
  const displayGroups = groups.map(g => {
    let name = getDomainDisplayName(g.domain);
    if (name === g.domain && settings.useSiteName) {
      const sn = extractSiteName(g.items[0]?.title);
      if (sn) name = sn;
    }
    return { ...g, displayName: name };
  });

  const total = displayGroups.reduce((s, g) => s + g.items.length, 0);
  const root = el('div', 'tree-root');
  const rootNode = el('div', 'tree-node root-node');
  rootNode.innerHTML = '<span class="node-label">浏览历史</span><span class="node-count">' + total + (mayBeTruncated ? '+' : '') + '</span>';
  root.appendChild(rootNode);
  const children = el('div', 'tree-children');

  if (settings.enableGroups) {
    const grouped = {};
    const ungrouped = [];
    displayGroups.forEach(g => {
      const gn = domainGroups[g.domain];
      if (gn) {
        if (!grouped[gn]) grouped[gn] = [];
        grouped[gn].push(g);
      } else {
        ungrouped.push(g);
      }
    });
    Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b)).forEach(([gn, items]) => {
      children.appendChild(makeGroupBranch(gn, items));
    });
    ungrouped.forEach(g => children.appendChild(makeDomainBranch(g)));
  } else {
    displayGroups.forEach(g => children.appendChild(makeDomainBranch(g)));
  }

  root.appendChild(children);
  if (mayBeTruncated) {
    const tip = el('div', 'empty');
    tip.style.padding = '6px'; tip.style.fontSize = '11px';
    tip.textContent = '实际记录可能更多，已显示 ' + total + ' 条';
    root.appendChild(tip);
  }
  container.appendChild(root);
  // Load favicons: chrome://favicon/ in extension pages
  if (settings.showFavicon) {
    requestAnimationFrame(() => loadFavicons());
  }
}

function makeGroupBranch(groupName, domainGroups) {
  const branch = el('div', 'tree-branch');
  const count = domainGroups.reduce((s, g) => s + g.items.length, 0);
  const latest = domainGroups.reduce((m, g) => Math.max(m, g.items[0]?.lastVisitTime || 0), 0);
  const node = el('div', 'tree-node group-node');
  node.innerHTML =
    '<span class="toggle">\u25B6</span>' +
    '<span class="node-label">' + esc(groupName) + '</span>' +
    '<span class="node-meta">' + count + '条 \u00B7 ' + fmtTime(latest) + '</span>';
  const childBox = el('div', 'tree-children collapsed');
  let rendered = false;
  node.addEventListener('click', e => {
    if (childBox.classList.contains('collapsed') && !rendered) {
      domainGroups.forEach(g => childBox.appendChild(makeDomainBranch(g)));
      rendered = true;
    }
    childBox.classList.toggle('collapsed');
    node.querySelector('.toggle').textContent = childBox.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
  });
  branch.appendChild(node);
  branch.appendChild(childBox);
  return branch;
}

function makeDomainBranch(group) {
  const branch = el('div', 'tree-branch');
  const node = el('div', 'tree-node domain-node');
  const count = group.items.length;
  let html = '<span class="toggle">\u25B6</span>';
  if (settings.showFavicon) {
    html += '<img class="favicon" loading="lazy" data-fav-domain="' + esc(group.domain) + '">';
  }
  html += '<span class="node-label" title="' + esc(group.domain) + '">' + esc(group.displayName) + '</span>';
  html += '<span class="node-meta">' + count + '条 \u00B7 ' + fmtTime(group.items[0]?.lastVisitTime) + '</span>';
  if (settings.enableStar) {
    html += '<span class="star-btn' + (domainStars[group.domain] ? ' active' : '') + '" data-domain="' + esc(group.domain) + '">\u2605</span>';
  }
  html += '<span class="edit-domain" title="编辑名称">\u270E</span>';
  node.innerHTML = html;

  // Star click
  const starEl = node.querySelector('.star-btn');
  if (starEl) {
    starEl.addEventListener('click', e => {
      e.stopPropagation();
      const d = starEl.dataset.domain;
      if (domainStars[d]) { delete domainStars[d]; starEl.classList.remove('active'); }
      else { domainStars[d] = true; starEl.classList.add('active'); }
      chrome.storage.local.set({ domainStars });
    });
  }

  // Edit click
  node.querySelector('.edit-domain').addEventListener('click', e => {
    e.stopPropagation();
    openEditDomainModal(group.domain);
  });

  const childBox = el('div', 'tree-children collapsed');
  let rendered = false;

  node.addEventListener('click', e => {
    if (e.target.classList.contains('edit-domain') || e.target.classList.contains('star-btn')) return;
    if (childBox.classList.contains('collapsed') && !rendered) {
      const limit = 30;
      group.items.slice(0, limit).forEach(item => {
        childBox.appendChild(el('div', 'tree-branch')).appendChild(makeLeafNode(item));
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
            childBox.appendChild(el('div', 'tree-branch')).appendChild(makeLeafNode(item));
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

function makeLeafNode(item) {
  const leaf = el('div', 'tree-node leaf-node');
  let html = '<span class="node-label" title="' + esc(item.url) + '">' + esc(item.title || '无标题') + '</span>';
  html += '<span class="node-time">' + fmtTime(item.lastVisitTime) + '</span>';
  if (settings.enableStar) {
    html += '<span class="star-btn' + (urlStars[item.url] ? ' active' : '') + '" data-url="' + esc(item.url) + '">\u2605</span>';
  }
  leaf.innerHTML = html;
  leaf.addEventListener('click', e => {
    if (e.target.classList.contains('star-btn')) {
      e.stopPropagation();
      const u = e.target.dataset.url;
      if (urlStars[u]) { delete urlStars[u]; e.target.classList.remove('active'); }
      else { urlStars[u] = true; e.target.classList.add('active'); }
      chrome.storage.local.set({ urlStars });
      return;
    }
    e.stopPropagation();
    chrome.tabs.create({ url: item.url });
  });
  return leaf;
}

// === Edit Domain Modal ===
function openEditDomainModal(domain) {
  editingDomain = domain;
  document.getElementById('edit-domain-original').textContent = domain;
  const input = document.getElementById('edit-domain-name');
  input.value = domainAliases[domain] || '';
  input.placeholder = domain;

  // Groups
  const groupSec = document.getElementById('edit-domain-group-section');
  if (settings.enableGroups) {
    groupSec.style.display = '';
    const list = document.getElementById('edit-domain-groups');
    list.innerHTML = '';
    allGroups.forEach(g => {
      const opt = el('div', 'tag-option' + (domainGroups[domain] === g ? ' selected' : ''));
      opt.textContent = g;
      opt.addEventListener('click', () => {
        list.querySelectorAll('.tag-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        document.getElementById('edit-domain-new-group').value = '';
      });
      list.appendChild(opt);
    });
    document.getElementById('edit-domain-new-group').value = domainGroups[domain] || '';
  } else {
    groupSec.style.display = 'none';
  }

  document.getElementById('edit-domain-modal').style.display = '';
  input.focus();
  input.select();
}

function initEditDomainModal() {
  const save = () => {
    const name = document.getElementById('edit-domain-name').value.trim();
    if (name && name !== editingDomain) domainAliases[editingDomain] = name;
    else delete domainAliases[editingDomain];

    if (settings.enableGroups) {
      const selGroup = document.querySelector('#edit-domain-groups .tag-option.selected');
      const newGroup = document.getElementById('edit-domain-new-group').value.trim();
      const group = newGroup || (selGroup ? selGroup.textContent : '');
      if (group) domainGroups[editingDomain] = group;
      else delete domainGroups[editingDomain];
      chrome.storage.local.set({ domainGroups });
    }

    chrome.storage.local.set({ domainAliases });
    document.getElementById('edit-domain-modal').style.display = 'none';
    renderCachedHistory();
  };

  document.getElementById('save-domain-name').addEventListener('click', save);
  document.getElementById('edit-domain-name').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  document.getElementById('reset-domain-name').addEventListener('click', () => {
    if (editingDomain) {
      delete domainAliases[editingDomain];
      delete domainGroups[editingDomain];
      chrome.storage.local.set({ domainAliases, domainGroups });
    }
    document.getElementById('edit-domain-modal').style.display = 'none';
    renderCachedHistory();
  });
  document.getElementById('cancel-edit-domain').addEventListener('click', () => {
    document.getElementById('edit-domain-modal').style.display = 'none';
  });
  document.getElementById('edit-domain-new-group').addEventListener('input', e => {
    if (e.target.value.trim()) {
      document.querySelectorAll('#edit-domain-groups .tag-option').forEach(o => o.classList.remove('selected'));
    }
  });
}

// === Settings ===
function initSettings() {
  document.getElementById('use-site-name').checked = settings.useSiteName;
  document.getElementById('show-favicon').checked = settings.showFavicon;
  document.getElementById('enable-groups').checked = settings.enableGroups;
  document.getElementById('enable-star').checked = settings.enableStar;
  document.querySelectorAll('input[name="dedupe"]').forEach(r => r.checked = r.value === settings.dedupe);

  document.getElementById('settings-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = '';
  });

  document.getElementById('save-settings').addEventListener('click', () => {
    settings.useSiteName = document.getElementById('use-site-name').checked;
    settings.showFavicon = document.getElementById('show-favicon').checked;
    settings.enableGroups = document.getElementById('enable-groups').checked;
    settings.enableStar = document.getElementById('enable-star').checked;
    const checked = document.querySelector('input[name="dedupe"]:checked');
    settings.dedupe = checked ? checked.value : 'none';
    chrome.storage.local.set({ settings });
    document.getElementById('settings-modal').style.display = 'none';
    renderCachedHistory();
  });
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
        const starKey = tagName + '|' + item.url;
        let html = '';
        if (settings.showFavicon) {
          html += '<img class="favicon" loading="lazy" data-fav-domain="' + esc(getMainDomain(item.url)) + '">';
        }
        html += '<span class="node-label" title="' + esc(item.url) + '">' + esc(item.displayTitle || item.title || '无标题') + '</span>';
        html += '<span class="node-time">' + fmtTime(item.addedAt) + '</span>';
        if (settings.enableStar) {
          html += '<span class="star-btn' + (tagStars[starKey] ? ' active' : '') + '" data-star-key="' + esc(starKey) + '">\u2605</span>';
        }
        html += '<span class="edit-tag-item" data-idx="' + i + '" title="编辑名称">\u270E</span>';
        html += '<span class="delete-item" data-idx="' + i + '" title="删除">\u2715</span>';
        leaf.innerHTML = html;
        leaf.addEventListener('click', ev => {
          if (ev.target.classList.contains('delete-item')) {
            ev.stopPropagation();
            items.splice(parseInt(ev.target.dataset.idx), 1);
            if (!items.length) delete tagsData[tagName];
            saveTags();
            renderTagsTree();
            return;
          }
          if (ev.target.classList.contains('edit-tag-item')) {
            ev.stopPropagation();
            openEditTagItemModal(tagName, parseInt(ev.target.dataset.idx));
            return;
          }
          if (ev.target.classList.contains('star-btn')) {
            ev.stopPropagation();
            const k = ev.target.dataset.starKey;
            if (tagStars[k]) { delete tagStars[k]; ev.target.classList.remove('active'); }
            else { tagStars[k] = true; ev.target.classList.add('active'); }
            chrome.storage.local.set({ tagStars });
            return;
          }
          ev.stopPropagation();
          chrome.tabs.create({ url: item.url });
        });
        childBox.appendChild(el('div', 'tree-branch')).appendChild(leaf);
      });
      // Load favicons for tag items
      if (settings.showFavicon) {
        requestAnimationFrame(() => loadTagFavicons(childBox));
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

function loadTagFavicons(container) {
  container.querySelectorAll('img[data-fav-domain]').forEach(img => {
    const d = img.dataset.favDomain;
    const pageUrl = 'https://' + d;
    const favUrl = 'https://www.google.com/s2/favicons?sz=32&domain_url=' + encodeURIComponent(pageUrl);
    img.onerror = function() { this.style.display = 'none'; };
    img.src = favUrl;
  });
}

// === Edit Tag Item Modal ===
function openEditTagItemModal(tag, idx) {
  editingTagItem = { tag, idx };
  const item = tagsData[tag][idx];
  document.getElementById('edit-tag-item-name').value = item.displayTitle || item.title || '';
  document.getElementById('edit-tag-item-modal').style.display = '';
  document.getElementById('edit-tag-item-name').focus();
}

function initEditTagItemModal() {
  const save = () => {
    if (!editingTagItem) return;
    const { tag, idx } = editingTagItem;
    const name = document.getElementById('edit-tag-item-name').value.trim();
    if (name) tagsData[tag][idx].displayTitle = name;
    saveTags();
    renderTagsTree();
    document.getElementById('edit-tag-item-modal').style.display = 'none';
    editingTagItem = null;
  };
  document.getElementById('save-tag-item-name').addEventListener('click', save);
  document.getElementById('edit-tag-item-name').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  document.getElementById('cancel-edit-tag-item').addEventListener('click', () => {
    document.getElementById('edit-tag-item-modal').style.display = 'none';
    editingTagItem = null;
  });
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
    const displayName = document.getElementById('display-name').value.trim() || currentPageInfo?.title || '';
    let tag = newTag || selectedTag;
    if (!tag) return;
    if (!tagsData[tag]) tagsData[tag] = [];
    tagsData[tag].push({ url: currentPageInfo.url, title: currentPageInfo.title, displayTitle: displayName, addedAt: Date.now() });
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

// === Quick Add (keyboard shortcut) ===
function openQuickAddModal() {
  if (!currentPageInfo) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0] || !tabs[0].url || tabs[0].url.startsWith('chrome')) return;
      currentPageInfo = { url: tabs[0].url, title: tabs[0].title || '' };
      showQuickAdd();
    });
  } else {
    showQuickAdd();
  }
}

function showQuickAdd() {
  const input = document.getElementById('quick-tag-input');
  const nameInput = document.getElementById('quick-display-name');
  input.value = '';
  nameInput.value = '';
  nameInput.placeholder = currentPageInfo.title || '无标题';
  document.getElementById('quick-tag-suggest').style.display = 'none';
  document.getElementById('quick-add-modal').style.display = '';
  input.focus();

  input.oninput = () => {
    const v = input.value.trim().toLowerCase();
    const list = document.getElementById('quick-tag-suggest');
    if (!v) { list.style.display = 'none'; return; }
    const matches = Object.keys(tagsData).filter(n => n.toLowerCase().includes(v));
    if (!matches.length) { list.style.display = 'none'; return; }
    list.innerHTML = '';
    matches.forEach(n => {
      const item = el('div', 'suggest-item');
      item.textContent = n;
      item.addEventListener('click', () => { input.value = n; list.style.display = 'none'; nameInput.focus(); });
      list.appendChild(item);
    });
    list.style.display = '';
  };

  input.onkeydown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doQuickAdd();
    }
  };
  nameInput.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); doQuickAdd(); }
  };
}

function doQuickAdd() {
  const tag = document.getElementById('quick-tag-input').value.trim();
  if (!tag || !currentPageInfo) return;
  const displayName = document.getElementById('quick-display-name').value.trim() || currentPageInfo.title || '';
  if (!tagsData[tag]) tagsData[tag] = [];
  tagsData[tag].push({ url: currentPageInfo.url, title: currentPageInfo.title, displayTitle: displayName, addedAt: Date.now() });
  saveTags();
  renderTagsTree();
  document.getElementById('quick-add-modal').style.display = 'none';
}

function initQuickAdd() {
  document.getElementById('quick-confirm').addEventListener('click', doQuickAdd);
  document.getElementById('quick-cancel').addEventListener('click', () => {
    document.getElementById('quick-add-modal').style.display = 'none';
  });
}

// === Export ===
function initExport() {
  document.getElementById('export-btn').addEventListener('click', () => {
    const days = parseInt(document.getElementById('time-range').value);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startTime = days <= 0 ? 0 : days <= 1 ? todayStart : Date.now() - days * 24 * 60 * 60 * 1000;
    const maxResults = days <= 0 ? 50000 : days <= 1 ? 2000 : days <= 7 ? 5000 : 20000;
    chrome.history.search({ text: '', startTime, maxResults }, items => {
      items = dedupeItems(items).filter(i => i.url && !i.url.startsWith('chrome') && !i.url.startsWith('about:'));
      const exportData = {
        exportedAt: new Date().toISOString(),
        timeRange: days <= 0 ? 'all' : days + 'd',
        history: items.map(i => ({ url: i.url, title: i.title, lastVisitTime: i.lastVisitTime ? new Date(i.lastVisitTime).toISOString() : null })),
        tags: tagsData,
        domainAliases,
        domainGroups,
        domainStars,
        urlStars
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'history-mindmap-export.json'; a.click();
      URL.revokeObjectURL(url);
    });
  });
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
