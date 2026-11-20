import {
  COLOR_HEX,
  TAB_GROUP_COLORS,
  createCollection,
  datedGroupName,
  dedupeTabs,
  downloadJson,
  escapeHtml,
  faviconSrc,
  formatDate,
  formatDay,
  formatRelative,
  getGroups,
  getSettings,
  hostOf,
  normalizeUrl,
  onGroupsChanged,
  plural,
  prettyUrl,
  setIgnored,
  setSettings,
  slugify,
  topDomains,
  updateGroups,
  validColor,
} from '../shared/store.js';
import {
  closeCollectionTabs,
  deleteCollections,
  focusCollection,
  isIncognitoAllowed,
  openCollections,
  openSingleUrl,
  saveTabsAsChromeGroup,
  saveTabsAsCollection,
  ungroupCollection,
} from '../shared/actions.js';
import { BRAND_MARK, icon } from '../shared/icons.js';
import { beginDragSelection } from '../shared/drag-select.js';

const GROUP_NONE = -1;
const THEME_ORDER = ['auto', 'light', 'dark'];
const OWN_PREFIX = chrome.runtime.getURL('');

const state = {
  view: 'groups',
  groups: [],
  settings: {
    autoSave: true,
    skipExisting: true,
    confirmDelete: true,
    trackIncognito: false,
    theme: 'auto',
  },
  tabs: [],
  windows: [],
  currentWindowId: null,
  lastActiveTabId: null,
  chromeGroups: [],
  liveGroupIds: new Set(),
  groupMetaById: new Map(),
  windowLabels: new Map(),
  tabCountByGroup: new Map(),

  search: '',
  statusFilter: 'all',
  colorFilter: null,
  sort: 'recent',

  tabSearch: '',
  windowFilter: 'current',
  tabGroupFilter: 'all',

  selectedGroups: new Set(),
  selectedTabs: new Set(),
  expanded: new Set(),
  lastGroupIndex: null,
  lastTabIndex: null,

  syncing: false,
};

let refreshToken = 0;
let activeMenu = null;
let groupDialogState = { color: 'blue', resolve: null, dated: false };
let confirmResolver = null;
let searchTimer = null;
let focusRefreshAt = 0;
let refreshDebounce = null;

let pickerSelection = new Set();
let pickerQuery = '';
let pickerAnchor = null;
let pickerClickGuard = false;
let pickerAnchorId = null;
let tabClickGuard = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  groupsView: $('#groupsView'),
  tabsView: $('#tabsView'),
  groupsBody: $('#groupsBody'),
  tabsBody: $('#tabsBody'),
  groupsEmpty: $('#groupsEmpty'),
  tabsEmpty: $('#tabsEmpty'),
  groupsTable: $('.groups-table'),
  tabsTable: $('.tabs-table'),
  selectionBar: $('#selectionBar'),
  selectionActions: $('#selectionActions'),
  selectionCount: $('#selectionCount'),
  selectionSub: $('#selectionSub'),
  groupSearch: $('#groupSearch'),
  tabSearch: $('#tabSearch'),
  toastHost: $('#toastHost'),
  groupDialog: $('#groupDialog'),
  confirmDialog: $('#confirmDialog'),
  settingsDialog: $('#settingsDialog'),
  tabPicker: $('#tabPicker'),
  pickerList: $('#pickerList'),
  pickerEmpty: $('#pickerEmpty'),
};

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  hydrateIcons();
  $('[data-brand]').innerHTML = BRAND_MARK;

  document.addEventListener(
    'error',
    (event) => {
      const img = event.target;
      if (img instanceof HTMLImageElement && img.closest('.favicon')) img.remove();
    },
    true,
  );

  try {
    state.settings = await getSettings();
  } catch (error) {
    console.warn('[TabStash] Could not load settings', error);
  }
  document.documentElement.dataset.theme = state.settings.theme || 'auto';
  renderThemeButton();

  try {
    state.sort = localStorage.getItem('tabstash-sort') || 'recent';
  } catch {
    state.sort = 'recent';
  }
  $('#groupSort').value = state.sort;

  const hashView = location.hash === '#tabs' ? 'tabs' : 'groups';
  state.view = hashView;
  updateViewChrome();

  wireEvents();

  await refreshData({ sync: true });

  onGroupsChanged(debounceRefresh);

  setInterval(() => {
    if (document.hidden || document.querySelector('dialog[open]') || activeMenu) return;
    if (state.view === 'groups') renderGroups();
    else renderTabs();
  }, 60000);
}

function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach((node) => {
    const svg = icon(node.dataset.icon, Number(node.dataset.size) || 16);
    if (svg) node.outerHTML = svg;
  });
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme || 'auto';
  renderThemeButton();
  markThemePicker();
}

function renderThemeButton() {
  const theme = state.settings.theme || 'auto';
  const button = $('#themeBtn');
  if (!button) return;
  const iconName = theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'auto';
  button.innerHTML = `${icon(iconName, 16)}<span>Theme: ${theme}</span>`;
  button.title = `Theme: ${theme} — click to change`;
}

function markThemePicker() {
  const current = state.settings.theme || 'auto';
  $$('#themePicker [data-theme-choice]').forEach((button) => {
    const active = button.dataset.themeChoice === current;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

async function setTheme(theme) {
  const next = THEME_ORDER.includes(theme) ? theme : 'auto';
  state.settings.theme = next;
  applyTheme();
  await setSettings({ theme: next });
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

async function requestBackgroundSync() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'tabstash:sync' });
    return result?.ok ?? true;
  } catch {
    return false;
  }
}

function setSyncSpinning(on) {
  state.syncing = on;
  const spinner = $('#syncBtn svg');
  if (spinner) spinner.classList.toggle('spinning', on);
  $('#syncBtn').disabled = on;
}

async function refreshData({ sync = false } = {}) {
  const token = ++refreshToken;
  if (sync) setSyncSpinning(true);

  try {
    if (sync) await requestBackgroundSync();

    const [groups, settings, tabs, windows, chromeGroups, currentWindow] = await Promise.all([
      getGroups(),
      getSettings(),
      chrome.tabs.query({}),
      chrome.windows.getAll({ populate: false }),
      chrome.tabGroups.query({}),
      chrome.windows.getCurrent().catch(() => null),
    ]);

    if (token !== refreshToken) return;

    state.groups = groups;
    state.settings = settings;
    state.currentWindowId = currentWindow?.id ?? null;

    const hiddenWindowIds = new Set(
      windows
        .filter(
          (w) =>
            w.incognito &&
            w.id !== state.currentWindowId &&
            !state.settings.trackIncognito,
        )
        .map((w) => w.id),
    );
    state.windows = windows
      .filter((w) => !hiddenWindowIds.has(w.id))
      .sort((a, b) => a.id - b.id);
    state.tabs = tabs.filter(
      (tab) => !hiddenWindowIds.has(tab.windowId) && isUsableTab(tab),
    );
    const activeTab = state.tabs.find((tab) => tab.active);
    if (activeTab) state.lastActiveTabId = activeTab.id;
    state.chromeGroups = chromeGroups
      .filter((group) => !hiddenWindowIds.has(group.windowId))
      .sort((a, b) => a.windowId - b.windowId || a.id - b.id);

    state.liveGroupIds = new Set(state.chromeGroups.map((group) => group.id));
    state.groupMetaById = new Map(state.chromeGroups.map((group) => [group.id, group]));
    state.tabCountByGroup = new Map();
    for (const tab of state.tabs) {
      if (tab.groupId === GROUP_NONE) continue;
      state.tabCountByGroup.set(tab.groupId, (state.tabCountByGroup.get(tab.groupId) || 0) + 1);
    }

    state.windowLabels = new Map();
    state.windows.forEach((win, index) => {
      state.windowLabels.set(
        win.id,
        win.id === state.currentWindowId ? 'This window' : `Window ${index + 1}`,
      );
    });

    pruneSelection();
    applyTheme();
    render();
  } catch (error) {
    console.error('[TabStash] Refresh failed', error);
    showToast('Could not read browser tabs. Try reloading the dashboard.', { tone: 'error' });
  } finally {
    if (token === refreshToken && sync) setSyncSpinning(false);
  }
}

function debounceRefresh() {
  clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(() => refreshData({ sync: false }), 180);
}

function pruneSelection() {
  const groupIds = new Set(state.groups.map((group) => group.id));
  for (const id of [...state.selectedGroups]) {
    if (!groupIds.has(id)) state.selectedGroups.delete(id);
  }
  const tabIds = new Set(state.tabs.map((tab) => tab.id));
  for (const id of [...state.selectedTabs]) {
    if (!tabIds.has(id)) state.selectedTabs.delete(id);
  }
}

function isUsableTab(tab) {
  const url = tab.url || tab.pendingUrl || '';
  if (!url) return false;
  if (url === 'chrome://newtab/') return false;
  if (url.startsWith(OWN_PREFIX)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isLive(group) {
  return Boolean(group?.link?.groupId != null && state.liveGroupIds.has(group.link.groupId));
}

function liveCount() {
  return state.groups.filter(isLive).length;
}

function totalTabs() {
  return state.groups.reduce((sum, group) => sum + group.tabs.length, 0);
}

function selectedGroupData() {
  return state.groups.filter((group) => state.selectedGroups.has(group.id));
}

function selectedTabData() {
  return state.tabs.filter((tab) => state.selectedTabs.has(tab.id));
}

function hueFor(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = value.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function faviconHtml(url, fallback = '', extraClass = '') {
  const host = hostOf(url);
  const letter = escapeHtml((host[0] || '?').toUpperCase());
  const hue = hueFor(host || url || 'x');
  const src = faviconSrc(url, fallback, 64);
  const tint = `color-mix(in srgb, hsl(${hue} 66% 56%) 18%, var(--surface))`;
  return `<span class="favicon ${extraClass}" style="--tint:${tint}"><span>${letter}</span><img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`;
}

function groupById(id) {
  return state.groups.find((group) => group.id === id) || null;
}

function tabGroupName(groupId) {
  if (groupId === GROUP_NONE) return 'Ungrouped';
  const group = state.groupMetaById.get(groupId);
  if (!group || !group.title) return 'Untitled group';
  return group.title;
}

function windowLabel(windowId) {
  return state.windowLabels.get(windowId) || 'Window';
}

function debounceSearch(callback, delay = 120) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(callback, delay);
}

function escapeAttr(value) {
  return escapeHtml(value);
}
/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render() {
  renderHeader();
  renderNav();
  renderFilters();
  if (state.view === 'groups') renderGroups();
  else renderTabs();
  renderSelectionBar();
}

function renderHeader() {
  const title = $('#pageTitle');
  const eyebrow = $('#eyebrow');
  const subtitle = $('#pageSubtitle');
  if (!title) return;

  if (state.view === 'groups') {
    eyebrow.textContent = 'Library';
    title.textContent = 'Saved groups';
    const live = liveCount();
    subtitle.textContent = `${plural(state.groups.length, 'group')} · ${plural(totalTabs(), 'tab')} stashed${live ? ` · ${live} open in Chrome` : ''}`;
  } else {
    eyebrow.textContent = 'Live browser';
    title.textContent = 'Open tabs';
    subtitle.textContent = `${plural(state.tabs.length, 'tab')} across ${plural(state.windows.length, 'window')}`;
  }
}

function renderNav() {
  $('#navGroupCount').textContent = String(state.groups.length);
  $('#navTabCount').textContent = String(state.tabs.length);
  $('#statGroups').textContent = String(state.groups.length);
  $('#statTabs').textContent = String(totalTabs());
}

function renderFilters() {
  const status = $('#statusFilter');
  if (status) {
    $$('button', status).forEach((button) => {
      button.classList.toggle('active', button.dataset.status === state.statusFilter);
    });
  }

  const colors = $('#colorFilter');
  if (!colors) return;
  colors.innerHTML = [
    `<button type="button" class="all ${state.colorFilter ? '' : 'active'}" data-color="" title="Any color" aria-label="Any color"></button>`,
    ...TAB_GROUP_COLORS.map(
      (color) =>
        `<button type="button" class="${state.colorFilter === color.name ? 'active' : ''}" data-color="${color.name}" style="--dot:${color.hex}" title="${color.name}" aria-label="${color.name}"></button>`,
    ),
  ].join('');
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

function getVisibleGroups() {
  const query = state.search.trim().toLowerCase();
  let list = state.groups.slice();

  if (state.statusFilter === 'live') list = list.filter(isLive);
  if (state.statusFilter === 'closed') list = list.filter((group) => !isLive(group));
  if (state.colorFilter) list = list.filter((group) => group.color === state.colorFilter);

  if (query) {
    list = list.filter((group) => {
      if (group.name.toLowerCase().includes(query)) return true;
      if (group.note && group.note.toLowerCase().includes(query)) return true;
      return group.tabs.some(
        (tab) =>
          tab.title.toLowerCase().includes(query) || tab.url.toLowerCase().includes(query),
      );
    });
  }

  switch (state.sort) {
    case 'created':
      list.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'name':
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      break;
    case 'size':
      list.sort((a, b) => b.tabs.length - a.tabs.length || a.name.localeCompare(b.name));
      break;
    default:
      list.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return list;
}

function renderGroups() {
  const visible = getVisibleGroups();

  els.groupsTable.hidden = visible.length === 0;
  els.groupsEmpty.hidden = visible.length > 0;

  els.groupsBody.innerHTML = visible.map((group) => renderGroupRow(group)).join('');

  const selectAll = $('#selectAllGroups');
  const selectedVisible = visible.filter((group) => state.selectedGroups.has(group.id)).length;
  selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  selectAll.disabled = visible.length === 0;

  renderGroupsEmpty(visible);
  $('#groupsFootnote').textContent = visible.length
    ? `${visible.length} of ${plural(state.groups.length, 'group')} shown · Groups marked Open stay linked to Chrome.`
    : '';
}

function renderGroupsEmpty(visible) {
  const title = $('#groupsEmptyTitle');
  const text = $('#groupsEmptyText');
  const actions = $('#groupsEmpty .empty-actions');
  if (!title || !text || !actions) return;

  const filtered =
    state.search.trim() || state.statusFilter !== 'all' || Boolean(state.colorFilter);

  if (state.groups.length === 0) {
    title.textContent = 'No saved groups yet';
    text.textContent =
      'Save a Chrome tab group, or click New group to pick tabs. TabStash keeps a copy so your groups survive closing.';
    actions.hidden = false;
    actions.innerHTML = `
      <button class="btn primary" type="button" data-empty-action="new">${icon('plus', 16)} Create a group</button>
      <button class="btn ghost" type="button" data-empty-action="tabs">Pick open tabs</button>`;
    return;
  }

  if (filtered) {
    title.textContent = 'No groups match';
    text.textContent = 'Try a different search, status, or color.';
    actions.hidden = false;
    actions.innerHTML = `<button class="btn ghost" type="button" data-empty-action="clear-groups">${icon('x', 15)} Clear filters</button>`;
    return;
  }

  title.textContent = 'No groups here';
  text.textContent = 'Nothing to show yet.';
  actions.hidden = true;
}

function renderGroupRow(group) {
  const live = isLive(group);
  const selected = state.selectedGroups.has(group.id);
  const expanded = state.expanded.has(group.id);
  const domains = topDomains(group.tabs, 2);
  const domainHtml = domains.top.length
    ? `${domains.top
        .map(
          ([host, count]) =>
            `<span class="domain-chip" title="${escapeAttr(host)} · ${count} tab${count === 1 ? '' : 's'}">${escapeHtml(host)}</span>`,
        )
        .join('')}${domains.extra ? `<span class="domain-more">+${domains.extra}</span>` : ''}`
    : '<span class="muted">—</span>';

  const subline = group.note
    ? escapeHtml(group.note)
    : `${live ? 'Linked to Chrome' : 'Saved snapshot'} <span class="dot-sep">·</span> ${group.source === 'auto' ? 'Auto-saved' : 'Manual'}`;

  const row = `
    <tr class="group-row ${selected ? 'is-selected' : ''}" data-id="${escapeAttr(group.id)}">
      <td class="check-col">
        <input type="checkbox" class="row-check" data-kind="group" data-id="${escapeAttr(group.id)}" aria-label="Select ${escapeAttr(group.name)}" ${selected ? 'checked' : ''} />
      </td>
      <td>
        <div class="group-cell">
          <button class="expand-btn ${expanded ? 'open' : ''}" type="button" data-action="expand" data-group-id="${escapeAttr(group.id)}" aria-expanded="${expanded}" title="${expanded ? 'Hide tabs' : 'Show tabs'}">
            ${icon('chevronRight', 15)}
          </button>
          <span class="color-dot" style="--dot:${COLOR_HEX[validColor(group.color)]}"></span>
          <div class="group-name-wrap">
            <button class="group-name" type="button" data-action="rename" data-group-id="${escapeAttr(group.id)}" title="Rename group">${escapeHtml(group.name)}</button>
            <span class="group-sub">${subline}</span>
          </div>
        </div>
      </td>
      <td class="num"><span class="tab-count">${group.tabs.length}</span></td>
      <td>${live ? '<span class="badge live"><span class="live-dot"></span>Open</span>' : '<span class="badge">Saved</span>'}</td>
      <td class="domains-col"><div class="domain-chips">${domainHtml}</div></td>
      <td class="muted" title="${escapeAttr(formatDate(group.updatedAt))}">${formatRelative(group.updatedAt)}</td>
      <td class="actions-col">
        <div class="row-actions">
          <button class="btn small open-btn" type="button" data-action="open-menu" data-group-id="${escapeAttr(group.id)}">
            ${icon('external', 13)}<span class="btn-label">Open</span>${icon('chevronDown', 11)}
          </button>
          <button class="icon-btn" type="button" data-action="more-menu" data-group-id="${escapeAttr(group.id)}" title="More actions" aria-label="More actions">
            ${icon('dots', 16)}
          </button>
        </div>
      </td>
    </tr>`;

  return expanded ? `${row}${renderGroupDetail(group)}` : row;
}

function renderGroupDetail(group) {
  const live = isLive(group);
  const uniqueCount = dedupeTabs(group.tabs).length;
  const duplicates = group.tabs.length - uniqueCount;

  const tabsHtml = group.tabs.length
    ? group.tabs
        .map((tab, index) => {
          const pinned = tab.pinned
            ? `<span class="pinned-mini" title="Pinned">${icon('pin', 12)}</span>`
            : '';
          return `
            <li>
              <button class="tab-open" type="button" data-action="open-saved-tab" data-group-id="${escapeAttr(group.id)}" data-url="${escapeAttr(tab.url)}" title="Open ${escapeAttr(tab.title)}">
                ${faviconHtml(tab.url, tab.favIconUrl)}
                <span class="tab-title">${escapeHtml(tab.title)}</span>
                ${pinned}
                <span class="tab-domain">${escapeHtml(hostOf(tab.url) || '')}</span>
              </button>
              ${
                live
                  ? ''
                  : `<button class="icon-btn tab-remove" type="button" data-action="remove-saved-tab" data-group-id="${escapeAttr(group.id)}" data-index="${index}" title="Remove tab from group" aria-label="Remove tab from group">${icon('x', 13)}</button>`
              }
            </li>`;
        })
        .join('')
    : '<li class="tab-empty">This group has no tabs.</li>';

  return `
    <tr class="detail-row">
      <td colspan="7">
        <div class="detail">
          <div class="detail-head">
            <span class="detail-title">${plural(group.tabs.length, 'tab')} in this group</span>
            <div class="detail-actions">
              <button class="btn ghost" type="button" data-action="open-group-window" data-group-id="${escapeAttr(group.id)}" ${group.tabs.length ? '' : 'disabled'}>${icon('window', 13)} Open all</button>
              <button class="btn ghost" type="button" data-action="copy-links" data-group-id="${escapeAttr(group.id)}" ${group.tabs.length ? '' : 'disabled'}>${icon('copy', 13)} Copy links</button>
              ${
                !live && duplicates
                  ? `<button class="btn ghost" type="button" data-action="dedupe-group" data-group-id="${escapeAttr(group.id)}">${icon('sparkles', 13)} Remove ${duplicates} duplicate${duplicates === 1 ? '' : 's'}</button>`
                  : ''
              }
              ${
                live
                  ? `<button class="btn ghost" type="button" data-action="close-group-tabs" data-group-id="${escapeAttr(group.id)}">${icon('x', 13)} Close tabs</button>`
                  : ''
              }
            </div>
          </div>
          <ul class="tab-list">${tabsHtml}</ul>
        </div>
      </td>
    </tr>`;
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function getVisibleTabs() {
  const query = state.tabSearch.trim().toLowerCase();
  let list = state.tabs.slice();

  if (state.windowFilter === 'current') {
    list = list.filter((tab) => tab.windowId === state.currentWindowId);
  } else if (state.windowFilter !== 'all') {
    const windowId = Number(state.windowFilter);
    list = list.filter((tab) => tab.windowId === windowId);
  }

  if (state.tabGroupFilter === 'ungrouped') {
    list = list.filter((tab) => tab.groupId === GROUP_NONE);
  } else if (state.tabGroupFilter !== 'all') {
    const groupId = Number(state.tabGroupFilter);
    list = list.filter((tab) => tab.groupId === groupId);
  }

  if (query) {
    list = list.filter((tab) => {
      if (tab.title.toLowerCase().includes(query)) return true;
      if ((tab.url || '').toLowerCase().includes(query)) return true;
      return tabGroupName(tab.groupId).toLowerCase().includes(query);
    });
  }

  const windowRank = new Map(state.windows.map((win, index) => [win.id, index]));
  list.sort(
    (a, b) =>
      (windowRank.get(a.windowId) ?? 0) - (windowRank.get(b.windowId) ?? 0) ||
      a.index - b.index,
  );
  return list;
}

function renderTabs() {
  renderTabFilters();
  const visible = getVisibleTabs();

  els.tabsTable.hidden = visible.length === 0;
  els.tabsEmpty.hidden = visible.length > 0;
  els.tabsBody.innerHTML = visible.map((tab) => renderTabRow(tab)).join('');

  syncTabSelectAll(visible);

  renderTabsEmpty(visible);
  $('#tabsFootnote').textContent = visible.length
    ? `${visible.length} of ${plural(state.tabs.length, 'tab')} shown · Click a tab to jump to it, or select tabs to save or group them.`
    : '';
}

function renderTabsEmpty(visible) {
  const title = $('#tabsEmptyTitle');
  const text = $('#tabsEmptyText');
  if (!title || !text) return;
  const filtered =
    state.tabSearch.trim() || state.windowFilter !== 'current' || state.tabGroupFilter !== 'all';

  if (!state.tabs.length) {
    title.textContent = 'No open tabs';
    text.textContent = 'Open a few tabs in Chrome and they will appear here.';
    return;
  }
  if (filtered) {
    title.textContent = 'No tabs match';
    text.textContent = 'Try a different window, group, or search term.';
    return;
  }
  title.textContent = 'No tabs in this window';
  text.textContent = 'Switch the window filter to see tabs from other windows.';
}

function syncTabSelectAll(visible = getVisibleTabs()) {
  const selectAll = $('#selectAllTabs');
  if (!selectAll) return;
  const selectedVisible = visible.filter((tab) => state.selectedTabs.has(tab.id)).length;
  selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  selectAll.disabled = visible.length === 0;
}

function renderTabFilters() {
  const windowSelect = $('#windowFilter');
  if (windowSelect) {
    const currentValue = state.windowFilter;
    const options = ['<option value="all">All windows</option>', '<option value="current">This window</option>'];
    state.windows.forEach((win, index) => {
      if (win.id === state.currentWindowId) return;
      const count = state.tabs.filter((tab) => tab.windowId === win.id).length;
      options.push(
        `<option value="${win.id}">Window ${index + 1} · ${plural(count, 'tab')}</option>`,
      );
    });
    windowSelect.innerHTML = options.join('');
    const values = [...windowSelect.options].map((option) => option.value);
    state.windowFilter = values.includes(currentValue) ? currentValue : 'current';
    windowSelect.value = state.windowFilter;
  }

  const groupSelect = $('#tabGroupFilter');
  if (groupSelect) {
    const currentValue = state.tabGroupFilter;
    const options = [
      '<option value="all">All groups</option>',
      '<option value="ungrouped">Ungrouped</option>',
    ];
    for (const group of state.chromeGroups) {
      const count = state.tabCountByGroup.get(group.id) || 0;
      options.push(
        `<option value="${group.id}">${escapeHtml(group.title || 'Untitled group')} · ${count}</option>`,
      );
    }
    groupSelect.innerHTML = options.join('');
    const values = [...groupSelect.options].map((option) => option.value);
    state.tabGroupFilter = values.includes(currentValue) ? currentValue : 'all';
    groupSelect.value = state.tabGroupFilter;
  }
}

function renderTabRow(tab) {
  const selected = state.selectedTabs.has(tab.id);
  const meta = state.groupMetaById.get(tab.groupId);
  const groupBadge = meta
    ? `<span class="tab-group-badge"><span class="color-dot" style="--dot:${COLOR_HEX[validColor(meta.color)]}"></span>${escapeHtml(meta.title || 'Untitled group')}</span>`
    : '<span class="ungrouped">Ungrouped</span>';
  const pinned = tab.pinned
    ? `<span class="pin-indicator">${icon('pin', 9)} Pinned</span>`
    : '';

  return `
    <tr class="tab-row ${selected ? 'is-selected' : ''}" data-tab-id="${tab.id}">
      <td class="check-col">
        <input type="checkbox" class="row-check" data-kind="tab" data-id="${tab.id}" aria-label="Select ${escapeAttr(tab.title)}" ${selected ? 'checked' : ''} />
      </td>
      <td>
        <div class="tab-cell" data-action="activate-tab" data-tab-id="${tab.id}" title="Jump to this tab">
          ${faviconHtml(tab.url, tab.favIconUrl, 'large')}
          <div class="tab-cell-text">
            <div class="tab-cell-title">${escapeHtml(tab.title)}${pinned}</div>
            <div class="tab-cell-url">${escapeHtml(prettyUrl(tab.url))}</div>
          </div>
        </div>
      </td>
      <td class="muted">${escapeHtml(windowLabel(tab.windowId))}</td>
      <td>${groupBadge}</td>
      <td class="muted">${tab.lastAccessed ? formatRelative(tab.lastAccessed) : '—'}</td>
    </tr>`;
}

/* ------------------------------------------------------------------ */
/* Selection bar                                                       */
/* ------------------------------------------------------------------ */

function renderSelectionBar() {
  const groups = selectedGroupData();
  const tabs = selectedTabData();
  const count = state.view === 'groups' ? groups.length : tabs.length;

  if (!count) {
    els.selectionBar.hidden = true;
    els.selectionActions.innerHTML = '';
    return;
  }

  els.selectionBar.hidden = false;

  if (state.view === 'groups') {
    const tabTotal = groups.reduce((sum, group) => sum + group.tabs.length, 0);
    els.selectionCount.textContent = plural(groups.length, 'group');
    els.selectionSub.textContent = plural(tabTotal, 'tab');
    els.selectionActions.innerHTML = `
      <button class="sel-btn primary" type="button" data-sel-action="open-menu">${icon('external', 14)} Open ${icon('chevronDown', 12)}</button>
      <button class="sel-btn" type="button" data-sel-action="merge">${icon('merge', 14)} Merge</button>
      <button class="sel-btn" type="button" data-sel-action="export">${icon('download', 14)} <span class="sel-label-optional">Export</span></button>
      <button class="sel-btn danger" type="button" data-sel-action="delete">${icon('trash', 14)} <span class="sel-label-optional">Delete</span></button>`;
    return;
  }

  const allPinned = tabs.every((tab) => tab.pinned);
  const windowCount = new Set(tabs.map((tab) => tab.windowId)).size;
  els.selectionCount.textContent = plural(tabs.length, 'tab');
  els.selectionSub.textContent = plural(windowCount, 'window');
  els.selectionActions.innerHTML = `
    <button class="sel-btn primary" type="button" data-sel-action="save-tabs">${icon('save', 14)} Save &amp; group</button>
    <button class="sel-btn" type="button" data-sel-action="snapshot-tabs">${icon('copy', 14)} <span class="sel-label-optional">Snapshot</span></button>
    <button class="sel-btn" type="button" data-sel-action="pin-toggle">${icon('pin', 14)} ${allPinned ? 'Unpin' : 'Pin'}</button>
    <button class="sel-btn" type="button" data-sel-action="move-menu">${icon('cornerDownRight', 14)} <span class="sel-label-optional">Move</span></button>
    <button class="sel-btn danger" type="button" data-sel-action="close-tabs">${icon('x', 14)} <span class="sel-label-optional">Close</span></button>`;
}
/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function updateViewChrome() {
  els.groupsView.hidden = state.view !== 'groups';
  els.tabsView.hidden = state.view !== 'tabs';
  $('#groupsFilters').hidden = state.view !== 'groups';
  $$('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
  });
  try {
    const url = state.view === 'tabs' ? '#tabs' : location.pathname + location.search;
    history.replaceState(null, '', url);
  } catch {
    /* ignore */
  }
}

async function switchView(view) {
  if (!['groups', 'tabs'].includes(view)) return;
  closeTabPicker();
  if (state.view === view) {
    render();
    return;
  }
  state.view = view;
  updateViewChrome();
  render();
  await refreshData({ sync: false });
}

async function syncLibrary() {
  if (state.syncing) return;
  await refreshData({ sync: true });
  showToast('Library synced with Chrome.', { tone: 'success' });
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

function wireEvents() {
  $$('.nav-item').forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });

  $('#syncBtn').addEventListener('click', syncLibrary);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#themeBtn').addEventListener('click', () => {
    const current = state.settings.theme || 'auto';
    const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
    setTheme(next);
  });

  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#newGroupBtn').addEventListener('click', () => openTabPicker($('#newGroupBtn')));
  $('#newGroupMenuBtn').addEventListener('click', () => openNewGroupMenu($('#newGroupMenuBtn')));
  $('#importFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await importFile(file);
  });

  els.groupSearch.addEventListener('input', (event) => {
    state.search = event.target.value;
    debounceSearch(() => {
      renderGroups();
      renderSelectionBar();
    });
  });

  els.tabSearch.addEventListener('input', (event) => {
    state.tabSearch = event.target.value;
    debounceSearch(() => {
      renderTabs();
      renderSelectionBar();
    });
  });

  $('#groupSort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    try {
      localStorage.setItem('tabstash-sort', state.sort);
    } catch {
      /* ignore */
    }
    renderGroups();
    renderSelectionBar();
  });

  $('#statusFilter').addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    state.statusFilter = button.dataset.status;
    state.lastGroupIndex = null;
    renderFilters();
    renderGroups();
    renderSelectionBar();
  });

  $('#colorFilter').addEventListener('click', (event) => {
    const button = event.target.closest('[data-color]');
    if (!button) return;
    state.colorFilter = button.dataset.color || null;
    state.lastGroupIndex = null;
    renderFilters();
    renderGroups();
    renderSelectionBar();
  });

  $('#selectAllGroups').addEventListener('change', (event) => {
    const visible = getVisibleGroups();
    if (event.target.checked) visible.forEach((group) => state.selectedGroups.add(group.id));
    else visible.forEach((group) => state.selectedGroups.delete(group.id));
    state.lastGroupIndex = null;
    renderGroups();
    renderSelectionBar();
  });

  $('#selectAllTabs').addEventListener('change', (event) => {
    const visible = getVisibleTabs();
    if (event.target.checked) visible.forEach((tab) => state.selectedTabs.add(tab.id));
    else visible.forEach((tab) => state.selectedTabs.delete(tab.id));
    state.lastTabIndex = null;
    renderTabs();
    renderSelectionBar();
  });

  els.groupsBody.addEventListener('click', (event) => {
    if (handleRowCheck(event, 'group')) return;
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const groupId = target.dataset.groupId || target.closest('tr')?.dataset.id;
    const group = groupId ? groupById(groupId) : null;
    if (!group) return;

    switch (target.dataset.action) {
      case 'expand':
        if (state.expanded.has(group.id)) state.expanded.delete(group.id);
        else state.expanded.add(group.id);
        renderGroups();
        break;
      case 'rename':
        renameGroup(group);
        break;
      case 'open-menu':
        openMenu(target, buildOpenItems([group]));
        break;
      case 'more-menu':
        openMenu(target, buildGroupMoreItems(group));
        break;
      case 'open-saved-tab':
        activateSavedTab(group, target.dataset.url);
        break;
      case 'remove-saved-tab':
        removeSavedTab(group, Number(target.dataset.index));
        break;
      case 'copy-links':
        copyGroupLinks(group);
        break;
      case 'dedupe-group':
        dedupeGroup(group);
        break;
      case 'close-group-tabs':
        closeGroupTabs(group);
        break;
      case 'open-group-window':
        doOpen([group], { mode: 'window' });
        break;
      default:
        break;
    }
  });

  els.tabsBody.addEventListener('click', (event) => {
    if (handleRowCheck(event, 'tab')) return;
    const target = event.target.closest('[data-action]');
    if (!target) return;
    if (target.dataset.action === 'activate-tab') {
      activateTab(Number(target.dataset.tabId));
    }
  });

  els.tabsBody.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.shiftKey) return;
    if (!event.target.closest('td.check-col')) return;
    const row = event.target.closest('tr.tab-row');
    if (!row) return;

    const started = beginDragSelection(event, {
      root: els.tabsBody,
      rowSelector: 'tr.tab-row',
      handleSelector: 'td.check-col',
      getRows: () => [...els.tabsBody.querySelectorAll('tr.tab-row')],
      isSelected: (id) => state.selectedTabs.has(Number(id)),
      apply: (id, value, rowEl) => {
        const tabId = Number(id);
        if (value) state.selectedTabs.add(tabId);
        else state.selectedTabs.delete(tabId);
        rowEl.classList.toggle('is-selected', value);
        const input = rowEl.querySelector('input.row-check');
        if (input) input.checked = value;
      },
      onChange: () => {
        syncTabSelectAll();
        renderSelectionBar();
      },
      onFinish: () => {
        setTimeout(() => {
          tabClickGuard = false;
        }, 0);
      },
    });
    if (!started) return;
    tabClickGuard = true;
    state.lastTabIndex = [...els.tabsBody.querySelectorAll('tr.tab-row')].indexOf(row);
  });

  els.selectionActions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-sel-action]');
    if (!button) return;
    handleSelectionAction(button.dataset.selAction, button);
  });

  $('#clearSelection').addEventListener('click', clearSelection);

  $('#windowFilter').addEventListener('change', (event) => {
    state.windowFilter = event.target.value;
    state.lastTabIndex = null;
    renderTabs();
    renderSelectionBar();
  });

  $('#tabGroupFilter').addEventListener('change', (event) => {
    state.tabGroupFilter = event.target.value;
    state.lastTabIndex = null;
    renderTabs();
    renderSelectionBar();
  });

  $('#clearTabFilters').addEventListener('click', resetTabFilters);

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-empty-action]');
    if (!button) return;
    switch (button.dataset.emptyAction) {
      case 'new':
        openNewGroupMenu(button);
        break;
      case 'tabs':
        switchView('tabs');
        break;
      case 'clear-groups':
        resetGroupFilters();
        break;
      case 'clear-tabs':
        resetTabFilters();
        break;
      default:
        break;
    }
  });

  wireDialogs();
  wireKeyboard();
  wireTabPicker();

  window.addEventListener('focus', () => {
    if (Date.now() - focusRefreshAt < 2000) return;
    focusRefreshAt = Date.now();
    if (document.querySelector('dialog[open]')) return;
    refreshData({ sync: false });
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - focusRefreshAt > 2000) {
      focusRefreshAt = Date.now();
      refreshData({ sync: false });
    }
  });
}

function handleRowCheck(event, kind) {
  const checkbox = event.target.closest('input.row-check');
  if (!checkbox || checkbox.dataset.kind !== kind) return false;
  event.preventDefault();

  if (kind === 'tab' && tabClickGuard) {
    // The pointerdown drag already toggled this checkbox.
    tabClickGuard = false;
    return true;
  }

  const list = kind === 'group' ? getVisibleGroups() : getVisibleTabs();
  const id = kind === 'group' ? checkbox.dataset.id : Number(checkbox.dataset.id);
  const set = kind === 'group' ? state.selectedGroups : state.selectedTabs;
  const index = list.findIndex((item) => item.id === id);
  const last = kind === 'group' ? state.lastGroupIndex : state.lastTabIndex;
  const shouldSelect = !set.has(id);

  if (event.shiftKey && last != null && last >= 0 && index >= 0) {
    const start = Math.min(last, index);
    const end = Math.max(last, index);
    for (let i = start; i <= end; i += 1) {
      const itemId = list[i].id;
      if (shouldSelect) set.add(itemId);
      else set.delete(itemId);
    }
  } else if (shouldSelect) {
    set.add(id);
  } else {
    set.delete(id);
  }

  if (kind === 'group') {
    state.lastGroupIndex = index;
    renderGroups();
  } else {
    state.lastTabIndex = index;
    renderTabs();
  }
  renderSelectionBar();
  return true;
}

function clearSelection() {
  state.selectedGroups.clear();
  state.selectedTabs.clear();
  state.lastGroupIndex = null;
  state.lastTabIndex = null;
  renderGroups();
  renderTabs();
  renderSelectionBar();
}

function resetGroupFilters() {
  state.search = '';
  state.statusFilter = 'all';
  state.colorFilter = null;
  els.groupSearch.value = '';
  state.lastGroupIndex = null;
  renderFilters();
  renderGroups();
  renderSelectionBar();
}

function resetTabFilters() {
  state.tabSearch = '';
  state.windowFilter = 'current';
  state.tabGroupFilter = 'all';
  els.tabSearch.value = '';
  state.lastTabIndex = null;
  renderTabs();
  renderSelectionBar();
}

/* ------------------------------------------------------------------ */
/* Group actions                                                       */
/* ------------------------------------------------------------------ */

function buildOpenItems(collections) {
  const items = [];
  const single = collections.length === 1 ? collections[0] : null;

  if (single && isLive(single)) {
    items.push({
      label: 'Focus open group',
      icon: 'focus',
      hint: 'Jump',
      onSelect: () => focusGroup(single),
    });
    items.push({ type: 'sep' });
  }

  items.push(
    {
      label: 'Open in current window',
      icon: 'monitor',
      desc:
        collections.length > 1
          ? `Creates ${plural(collections.length, 'tab group')}`
          : state.settings.skipExisting
            ? 'Skips tabs already open'
            : undefined,
      onSelect: () => doOpen(collections, { mode: 'current' }),
    },
    {
      label: 'Open in new window',
      icon: 'window',
      onSelect: () => doOpen(collections, { mode: 'window' }),
    },
    {
      label: 'Open in incognito',
      icon: 'incognito',
      desc: 'Private window',
      onSelect: () => doOpen(collections, { mode: 'incognito' }),
    },
    { type: 'sep' },
    {
      label: 'Open ungrouped in current window',
      icon: 'tab',
      onSelect: () => doOpen(collections, { mode: 'current', grouped: false }),
    },
    {
      label: 'Open ungrouped in new window',
      icon: 'window',
      onSelect: () => doOpen(collections, { mode: 'window', grouped: false }),
    },
  );

  if (single) {
    items.push({ type: 'sep' }, {
      label: 'Copy all links',
      icon: 'copy',
      onSelect: () => copyGroupLinks(single),
    }, {
      label: isLive(single) ? 'Ungroup & remove' : 'Delete group',
      icon: 'trash',
      desc: isLive(single) ? 'Tabs stay open' : 'Removes it from the library',
      danger: true,
      onSelect: () => deleteGroupSelection([single]),
    });
  }
  return items;
}

function buildGroupMoreItems(group) {
  const live = isLive(group);
  return [
    {
      label: 'Rename & color',
      icon: 'pencil',
      onSelect: () => renameGroup(group),
    },
    {
      label: 'Change color',
      icon: 'palette',
      onSelect: (anchor) => openColorMenu(anchor, group.color, (color) => changeGroupColor(group, color)),
    },
    {
      label: 'Duplicate',
      icon: 'copy',
      hint: 'Saved copy',
      onSelect: () => duplicateGroup(group),
    },
    {
      label: 'Export as JSON',
      icon: 'download',
      onSelect: () => exportGroups([group]),
    },
    { type: 'sep' },
    ...(live
      ? [
          {
            label: 'Ungroup in Chrome',
            icon: 'layers',
            desc: 'Tabs stay open',
            onSelect: () => ungroupGroup(group),
          },
          {
            label: 'Close all tabs',
            icon: 'x',
            desc: 'Keeps this saved group',
            onSelect: () => closeGroupTabs(group),
          },
        ]
      : []),
    { type: 'sep' },
    {
      label: live ? 'Ungroup & remove' : 'Delete group',
      icon: 'trash',
      desc: live ? 'Tabs stay open' : undefined,
      danger: true,
      onSelect: () => deleteGroupSelection([group]),
    },
  ];
}

async function doOpen(collections, options = {}) {
  const list = (collections || []).filter((group) => group.tabs.length);
  if (!list.length) {
    showToast('This group has no tabs to open.', { tone: 'warning' });
    return;
  }
  try {
    const result = await openCollections(list, {
      ...options,
      skipExisting: Boolean(options.mode === 'current' && state.settings.skipExisting),
    });
    if (!result.opened) {
      showToast('Those tabs are already open in this window.', { tone: 'warning' });
    } else {
      showToast(
        `Opened ${plural(result.opened, 'tab')}${
          result.groupIds.length > 1 ? ` in ${plural(result.groupIds.length, 'group')}` : ''
        }.`,
        { tone: 'success' },
      );
    }
    await refreshData({ sync: false });
  } catch (error) {
    if (error?.code === 'INCOGNITO_DISABLED') {
      showIncognitoHelp();
    } else {
      console.error('[TabStash] Open failed', error);
      showToast('Could not open that group.', { tone: 'error' });
    }
  }
}

async function focusGroup(group) {
  const focused = await focusCollection(group);
  if (!focused) {
    showToast('That Chrome group is no longer open.', { tone: 'warning' });
    await refreshData({ sync: true });
  }
}

async function renameGroup(group) {
  const result = await askGroup({
    title: 'Rename group',
    subtitle: 'Update the saved name and color.',
    name: group.name,
    color: group.color,
    confirmText: 'Save changes',
  });
  if (!result) return;

  await updateGroups((groups) => {
    const found = groups.find((item) => item.id === group.id);
    if (found) {
      found.name = result.name;
      found.color = result.color;
      found.updatedAt = Date.now();
    }
    return groups;
  });

  if (isLive(group)) {
    try {
      await chrome.tabGroups.update(group.link.groupId, {
        title: result.name,
        color: result.color,
      });
    } catch {
      /* group may have just closed */
    }
  }

  await refreshData({ sync: false });
  showToast('Group updated.', { tone: 'success' });
}

async function changeGroupColor(group, color) {
  await updateGroups((groups) => {
    const found = groups.find((item) => item.id === group.id);
    if (found) {
      found.color = color;
      found.updatedAt = Date.now();
    }
    return groups;
  });
  if (isLive(group)) {
    try {
      await chrome.tabGroups.update(group.link.groupId, { color });
    } catch {
      /* ignore */
    }
  }
  await refreshData({ sync: false });
}

async function duplicateGroup(group) {
  const copy = createCollection({
    name: `${group.name} (copy)`,
    color: group.color,
    tabs: group.tabs,
    source: 'manual',
    note: group.note,
  });
  await updateGroups((groups) => {
    groups.unshift(copy);
    return groups;
  });
  state.expanded.add(copy.id);
  await refreshData({ sync: false });
  showToast('Group duplicated.', { tone: 'success' });
}

async function ungroupGroup(group) {
  const ok = await confirmDialog({
    title: 'Ungroup in Chrome?',
    body: `The ${plural(group.tabs.length, 'tab')} stay open, but Chrome will no longer group them.`,
    confirmText: 'Ungroup',
    danger: false,
  });
  if (!ok) return;
  const done = await ungroupCollection(group);
  await refreshData({ sync: false });
  showToast(done ? 'Chrome group removed.' : 'That group was already ungrouped.', {
    tone: done ? 'success' : 'warning',
  });
}

async function closeGroupTabs(group) {
  const ok = await confirmDialog({
    title: 'Close all tabs?',
    body: `This closes ${plural(group.tabs.length, 'tab')} in the open Chrome group. The saved group stays in your library.`,
    confirmText: 'Close tabs',
    danger: true,
  });
  if (!ok) return;
  const done = await closeCollectionTabs(group);
  await refreshData({ sync: false });
  showToast(done ? 'Tabs closed. The group was saved.' : 'Those tabs were already closed.', {
    tone: done ? 'success' : 'warning',
  });
}

async function removeSavedTab(group, index) {
  const tab = group.tabs[index];
  if (!tab) return;
  await updateGroups((groups) => {
    const found = groups.find((item) => item.id === group.id);
    if (!found) return groups;
    found.tabs.splice(index, 1);
    found.updatedAt = Date.now();
    if (!found.tabs.length) return groups.filter((item) => item.id !== group.id);
    return groups;
  });
  await refreshData({ sync: false });
  showToast(`Removed “${tab.title}” from the group.`, { tone: 'success' });
}

async function dedupeGroup(group) {
  const unique = dedupeTabs(group.tabs);
  const removed = group.tabs.length - unique.length;
  if (removed <= 0) return;
  await updateGroups((groups) => {
    const found = groups.find((item) => item.id === group.id);
    if (found) {
      found.tabs = unique;
      found.updatedAt = Date.now();
    }
    return groups;
  });
  await refreshData({ sync: false });
  showToast(`Removed ${plural(removed, 'duplicate tab')}.`, { tone: 'success' });
}

async function deleteGroupSelection(groups) {
  if (!groups.length) return;
  const liveGroups = groups.filter(isLive);

  if (state.settings.confirmDelete !== false) {
    const ok = await confirmDialog({
      title:
        groups.length === 1
          ? `Delete “${groups[0].name}”?`
          : `Delete ${plural(groups.length, 'group')}?`,
      body:
        groups.length === 1
          ? `This removes ${plural(groups[0].tabs.length, 'tab')} from your saved library.`
          : `This removes ${plural(
              groups.reduce((sum, group) => sum + group.tabs.length, 0),
              'tab',
            )} from your saved library.`,
      note: liveGroups.length
        ? 'The Chrome group tag will be removed too. Its tabs stay open.'
        : '',
      confirmText: liveGroups.length ? 'Ungroup & remove' : 'Delete',
      danger: true,
    });
    if (!ok) return;
  }

  await deleteCollections(groups.map((group) => group.id));
  groups.forEach((group) => {
    state.selectedGroups.delete(group.id);
    state.expanded.delete(group.id);
  });
  await refreshData({ sync: false });
  showToast(
    groups.length === 1
      ? liveGroups.length
        ? 'Group removed and ungrouped — tabs are still open.'
        : 'Group removed from library.'
      : `${groups.length} groups removed.`,
    { tone: 'success' },
  );
}

async function copyGroupLinks(group) {
  await copyText(group.tabs.map((tab) => tab.url).join('\n'), plural(group.tabs.length, 'link'));
}

async function activateSavedTab(group, url) {
  if (isLive(group)) {
    try {
      const tabs = await chrome.tabs.query({ groupId: group.link.groupId });
      const match = tabs.find((tab) => normalizeUrl(tab.url || '') === normalizeUrl(url));
      if (match) {
        await activateTab(match.id);
        return;
      }
    } catch {
      /* fall through */
    }
  }
  await openSingleUrl(url);
}

async function activateTab(tabId) {
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab) return;
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  } catch {
    showToast('That tab is no longer open.', { tone: 'warning' });
  }
}

/* ------------------------------------------------------------------ */
/* Tab actions                                                         */
/* ------------------------------------------------------------------ */

async function handleSelectionAction(action, anchor) {
  const groups = selectedGroupData();
  const tabs = selectedTabData();

  switch (action) {
    case 'open-menu':
      if (groups.length) openMenu(anchor, buildOpenItems(groups));
      break;
    case 'merge':
      await mergeGroups(groups);
      break;
    case 'export':
      exportGroups(groups);
      break;
    case 'delete':
      await deleteGroupSelection(groups);
      break;
    case 'save-tabs':
      await saveSelectedTabs();
      break;
    case 'snapshot-tabs':
      await saveTabsAsSnapshot(selectedTabData());
      break;
    case 'pin-toggle':
      await togglePinSelected();
      break;
    case 'move-menu':
      openMenu(anchor, buildMoveItems(tabs));
      break;
    case 'close-tabs':
      await closeSelectedTabs();
      break;
    default:
      break;
  }
}

async function saveCurrentWindow() {
  const windowId = state.currentWindowId;
  if (!windowId) return;
  const tabs = state.tabs.filter((tab) => tab.windowId === windowId);
  if (!tabs.length) {
    showToast('There are no tabs to save in this window.', { tone: 'warning' });
    return;
  }

  const result = await askGroup({
    title: 'Save this window',
    subtitle: `${plural(tabs.length, 'tab')} will be grouped in Chrome and saved.`,
    name: 'Window',
    color: 'blue',
    confirmText: 'Save group',
    dated: true,
  });
  if (!result) return;

  const { groupIds, snapshot, skipped } = await saveTabsAsChromeGroup(tabs, {
    name: result.name,
    color: result.color,
    source: 'manual',
  });
  if (snapshot) state.expanded.add(snapshot.id);
  for (const group of state.groups) {
    if (groupIds.includes(group.link?.groupId)) state.expanded.add(group.id);
  }
  state.view = 'groups';
  updateViewChrome();
  await refreshData({ sync: true });
  if (groupIds.length) {
    const grouped = tabs.length - skipped;
    showToast(
      skipped
        ? `Saved & grouped ${plural(grouped, 'tab')}. ${plural(skipped, 'pinned tab')} stayed ungrouped.`
        : `Saved & grouped ${plural(grouped, 'tab')}.`,
      { tone: 'success' },
    );
  } else {
    showToast('Saved as a snapshot — pinned tabs cannot be grouped.', {
      tone: 'warning',
    });
  }
}

async function saveSelectedTabs() {
  await saveTabsAsGroup(selectedTabData());
}

/**
 * Save open tabs as a group that appears in Chrome's tab bar. The created
 * collections are linked, so they stay in sync with the Chrome groups.
 */
async function saveTabsAsGroup(tabs, { closePicker = false } = {}) {
  if (!tabs.length) return;
  const windows = new Set(tabs.map((tab) => tab.windowId));

  const result = await askGroup({
    title: 'Save & group',
    subtitle: `${plural(tabs.length, 'tab')} from ${plural(windows.size, 'window')} will be grouped in Chrome and saved.`,
    name: suggestGroupName(tabs),
    color: 'blue',
    confirmText: 'Save & group',
    dated: true,
  });
  if (!result) return;

  const { groupIds, snapshot, skipped } = await saveTabsAsChromeGroup(tabs, {
    name: result.name,
    color: result.color,
    source: 'manual',
  });

  state.selectedTabs.clear();
  state.lastTabIndex = null;
  if (closePicker) closeTabPicker();
  state.view = 'groups';
  updateViewChrome();
  await refreshData({ sync: true });

  for (const group of state.groups) {
    if (snapshot && group.id === snapshot.id) state.expanded.add(group.id);
    if (groupIds.includes(group.link?.groupId)) state.expanded.add(group.id);
  }
  render();

  if (groupIds.length) {
    const grouped = tabs.length - skipped;
    showToast(
      skipped
        ? `Saved & grouped ${plural(grouped, 'tab')}. ${plural(skipped, 'pinned tab')} stayed ungrouped.`
        : `Saved & grouped ${plural(grouped, 'tab')}.`,
      { tone: 'success' },
    );
  } else {
    showToast('Saved as a snapshot — pinned tabs cannot be grouped.', { tone: 'warning' });
  }
}

async function togglePinSelected() {
  const tabs = selectedTabData();
  if (!tabs.length) return;
  const shouldPin = !tabs.every((tab) => tab.pinned);
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs.update(tab.id, { pinned: shouldPin }).catch(() => null),
    ),
  );
  await refreshData({ sync: false });
  showToast(`${shouldPin ? 'Pinned' : 'Unpinned'} ${plural(tabs.length, 'tab')}.`, {
    tone: 'success',
  });
}

function buildMoveItems(tabs) {
  const currentWindowId = state.currentWindowId;
  const items = [];
  state.windows.forEach((win) => {
    if (win.id === currentWindowId) {
      items.push({
        label: 'This window',
        icon: 'monitor',
        onSelect: () => moveTabsToWindow(tabs, win.id),
      });
    } else {
      items.push({
        label: windowLabel(win.id),
        icon: 'window',
        onSelect: () => moveTabsToWindow(tabs, win.id),
      });
    }
  });
  if (!items.length) {
    items.push({ label: 'No other windows open', disabled: true });
  }
  return items;
}

async function moveTabsToWindow(tabs, windowId) {
  if (!tabs.length) return;
  try {
    await chrome.tabs.move(
      tabs.map((tab) => tab.id),
      { windowId, index: -1 },
    );
    state.selectedTabs.clear();
    await refreshData({ sync: true });
    showToast(`Moved ${plural(tabs.length, 'tab')} to ${windowLabel(windowId).toLowerCase()}.`, {
      tone: 'success',
    });
  } catch (error) {
    console.error('[TabStash] Move failed', error);
    showToast('Could not move those tabs.', { tone: 'error' });
  }
}

async function closeSelectedTabs() {
  const tabs = selectedTabData();
  if (!tabs.length) return;
  const ok = await confirmDialog({
    title: `Close ${plural(tabs.length, 'tab')}?`,
    body: 'The tabs will be closed. Saved groups are not affected.',
    confirmText: 'Close tabs',
    danger: true,
  });
  if (!ok) return;
  await chrome.tabs.remove(tabs.map((tab) => tab.id));
  state.selectedTabs.clear();
  await refreshData({ sync: false });
  showToast(`Closed ${plural(tabs.length, 'tab')}.`, { tone: 'success' });
}

async function mergeGroups(groups) {
  if (groups.length < 2) return;
  const result = await askGroup({
    title: 'Merge groups',
    subtitle: `${plural(groups.length, 'group')} · ${plural(
      groups.reduce((sum, group) => sum + group.tabs.length, 0),
      'tab',
    )}`,
    name: 'Merged group',
    color: groups[0].color,
    confirmText: 'Create merged group',
    hint: 'This creates a new group with duplicates removed. The original groups stay in your library.',
    dated: true,
  });
  if (!result) return;

  const tabs = dedupeTabs(groups.flatMap((group) => group.tabs));
  const collection = createCollection({
    name: result.name,
    color: result.color,
    tabs,
    source: 'manual',
  });
  await updateGroups((all) => {
    all.unshift(collection);
    return all;
  });
  state.selectedGroups.clear();
  state.lastGroupIndex = null;
  state.expanded.add(collection.id);
  await refreshData({ sync: false });
  showToast(`Merged ${plural(groups.length, 'group')} into one.`, { tone: 'success' });
}

function suggestGroupName(tabs) {
  const hosts = [...new Set(tabs.map((tab) => hostOf(tab.url)).filter(Boolean))];
  if (hosts.length === 1) return hosts[0];
  return 'Selected tabs';
}
/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

function rectOf(anchor) {
  if (!anchor) return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  if (anchor.rect) return anchor.rect;
  if (typeof anchor.getBoundingClientRect === 'function') return anchor.getBoundingClientRect();
  return anchor;
}

function positionMenu(menu, anchor) {
  document.body.append(menu);
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';

  const rect = rectOf(anchor);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = Math.min(rect.right - width, window.innerWidth - 12 - width);
  left = Math.max(12, left);
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 6);

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = '';
  menu.classList.add('open');
}

function menuPointerDown(event) {
  if (activeMenu && activeMenu.contains(event.target)) return;
  closeMenu();
}

function menuKeyDown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeMenu();
  }
}

function armMenuClose(menu) {
  activeMenu = menu;
  setTimeout(() => {
    if (activeMenu !== menu) return;
    document.addEventListener('pointerdown', menuPointerDown, true);
    document.addEventListener('keydown', menuKeyDown, true);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
  }, 0);
}

function closeMenu() {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
  document.removeEventListener('pointerdown', menuPointerDown, true);
  document.removeEventListener('keydown', menuKeyDown, true);
  window.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('resize', closeMenu);
}

function openMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');

  menu.innerHTML = items
    .map((item, index) => {
      if (item.type === 'sep') return '<div class="menu-sep" role="separator"></div>';
      if (item.type === 'label')
        return `<div class="menu-label">${escapeHtml(item.label)}</div>`;
      if (item.type === 'note') return `<div class="menu-note">${escapeHtml(item.text)}</div>`;
      if (!item.label) return '';
      const desc = item.desc
        ? `<span class="menu-desc">${escapeHtml(item.desc)}</span>`
        : '';
      return `<button class="menu-item ${item.danger ? 'danger' : ''}" type="button" role="menuitem" data-index="${index}" ${item.disabled ? 'disabled' : ''}>
        ${item.icon ? `<span class="menu-icon">${icon(item.icon, 15)}</span>` : ''}
        <span class="menu-text">${escapeHtml(item.label)}${desc}</span>
        ${item.hint ? `<span class="menu-hint">${escapeHtml(item.hint)}</span>` : ''}
      </button>`;
    })
    .join('');

  menu.addEventListener('click', (event) => {
    const button = event.target.closest('.menu-item');
    if (!button) return;
    const item = items[Number(button.dataset.index)];
    if (!item || item.disabled) return;
    const rect = button.getBoundingClientRect();
    closeMenu();
    Promise.resolve(item.onSelect?.({ rect })).catch((error) => {
      console.error('[TabStash] Menu action failed', error);
      showToast('Something went wrong.', { tone: 'error' });
    });
  });

  positionMenu(menu, anchor);
  armMenuClose(menu);
}

function openColorMenu(anchor, currentColor, onPick) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu color-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="menu-label">Group color</div><div class="color-menu-grid"></div>`;
  const grid = menu.querySelector('.color-menu-grid');
  grid.innerHTML = TAB_GROUP_COLORS.map(
    (color) =>
      `<button type="button" class="swatch ${color.name === currentColor ? 'selected' : ''}" style="--dot:${color.hex}" data-color="${color.name}" title="${color.name}" aria-label="${color.name}">${color.name === currentColor ? icon('check', 13, 'swatch-check') : ''}</button>`,
  ).join('');
  menu.addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-color]');
    if (!swatch) return;
    closeMenu();
    onPick(swatch.dataset.color);
  });
  positionMenu(menu, anchor);
  armMenuClose(menu);
}

/* ------------------------------------------------------------------ */
/* Toasts / clipboard                                                  */
/* ------------------------------------------------------------------ */

function showToast(message, { tone = 'default', duration = 3400, action = null } = {}) {
  const host = els.toastHost;
  while (host.children.length >= 3) host.firstElementChild?.remove();

  const element = document.createElement('div');
  element.className = `toast ${tone}`;
  const iconName =
    tone === 'success' ? 'check' : tone === 'error' || tone === 'warning' ? 'alert' : 'info';
  element.innerHTML = `<span class="toast-icon">${icon(iconName, 13)}</span><span class="toast-msg"></span>`;
  element.querySelector('.toast-msg').textContent = message;
  host.append(element);

  const dismiss = () => {
    element.classList.add('hide');
    setTimeout(() => element.remove(), 220);
  };
  if (action) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.onClick?.();
      dismiss();
    });
    element.append(button);
  }
  setTimeout(dismiss, duration);
}

async function copyText(text, label = 'links') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${label}.`, { tone: 'success', duration: 2000 });
  } catch {
    showToast('Could not copy to the clipboard.', { tone: 'error' });
  }
}

function showIncognitoHelp() {
  showToast(
    'Incognito access is off. Enable “Allow in Incognito” for TabStash in chrome://extensions → Details.',
    {
      tone: 'warning',
      duration: 8000,
      action: { label: 'Extensions', onClick: openExtensionsPage },
    },
  );
}

async function openExtensionsPage() {
  try {
    await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  } catch {
    await copyText('chrome://extensions');
  }
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

function buildSwatches(container, selected) {
  container.innerHTML = TAB_GROUP_COLORS.map(
    (color) =>
      `<button type="button" class="swatch ${color.name === selected ? 'selected' : ''}" style="--dot:${color.hex}" data-color="${color.name}" role="radio" aria-checked="${color.name === selected}" title="${color.name}" aria-label="${color.name}">${
        color.name === selected ? icon('check', 13, 'swatch-check') : ''
      }</button>`,
  ).join('');
}

function settleGroupDialog(ok) {
  const pending = groupDialogState;
  if (!pending.resolve) return;
  const resolve = pending.resolve;
  groupDialogState = { color: pending.color, resolve: null, dated: false };
  if (!ok) {
    resolve(null);
    return;
  }
  const input = $('#groupName');
  const base = (input?.value || '').trim() || 'Untitled group';
  resolve({
    name: pending.dated ? datedGroupName(base) : base,
    color: pending.color,
  });
}

function settleConfirmDialog(ok) {
  const resolve = confirmResolver;
  confirmResolver = null;
  resolve?.(ok);
}

function closeDialog(dialog, returnValue = 'cancel') {
  if (!dialog) return;
  dialog.close(returnValue);
  if (dialog === els.groupDialog) settleGroupDialog(returnValue === 'ok');
  if (dialog === els.confirmDialog) settleConfirmDialog(returnValue === 'ok');
}

function askGroup({
  title = 'Save group',
  subtitle = 'Give your group a name and a color.',
  name = '',
  color = 'blue',
  confirmText = 'Save group',
  hint = '',
  dated = false,
} = {}) {
  if (els.groupDialog.open) return Promise.resolve(null);

  return new Promise((resolve) => {
    const dialog = els.groupDialog;
    groupDialogState = { color: validColor(color), resolve, dated };

    $('#groupDialogTitle').textContent = title;
    $('#groupDialogSub').textContent = subtitle;
    $('#groupSubmit').textContent = confirmText;
    const input = $('#groupName');
    input.value = name;
    input.classList.remove('invalid');
    const suffix = $('#groupNameSuffix');
    suffix.textContent = `· ${formatDay()}`;
    suffix.hidden = !dated;
    const hintEl = $('#groupDialogHint');
    hintEl.hidden = !hint;
    hintEl.textContent = hint;
    buildSwatches($('#groupColors'), groupDialogState.color);

    dialog.returnValue = '';
    dialog.showModal();
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

function confirmDialog({ title, body, note = '', confirmText = 'Delete', danger = true }) {
  if (els.confirmDialog.open) return Promise.resolve(false);

  return new Promise((resolve) => {
    const dialog = els.confirmDialog;
    confirmResolver = resolve;
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    const noteEl = $('#confirmNote');
    noteEl.hidden = !note;
    noteEl.textContent = note;
    const submit = $('#confirmSubmit');
    submit.textContent = confirmText;
    submit.className = `btn ${danger ? 'danger' : 'primary'}`;

    dialog.returnValue = '';
    dialog.showModal();
    setTimeout(() => submit.focus(), 40);
  });
}

function wireDialogs() {
  $$('[data-dialog-close]').forEach((button) => {
    button.addEventListener('click', () => closeDialog(button.closest('dialog'), 'cancel'));
  });

  $$('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeDialog(dialog, 'cancel');
    });
    // Escape and other native closes skip closeDialog, so settle here too.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog(dialog, 'cancel');
    });
    dialog.addEventListener('close', () => {
      if (dialog === els.groupDialog) settleGroupDialog(dialog.returnValue === 'ok');
      if (dialog === els.confirmDialog) settleConfirmDialog(dialog.returnValue === 'ok');
    });
  });

  $('#groupForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#groupName');
    if (!input.value.trim()) {
      input.classList.add('invalid');
      input.focus();
      return;
    }
    closeDialog(els.groupDialog, 'ok');
  });

  $('#groupName').addEventListener('input', (event) => {
    event.target.classList.remove('invalid');
  });

  $('#groupColors').addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-color]');
    if (!swatch) return;
    groupDialogState.color = swatch.dataset.color;
    buildSwatches($('#groupColors'), groupDialogState.color);
  });

  $('#confirmForm').addEventListener('submit', (event) => {
    event.preventDefault();
    closeDialog(els.confirmDialog, 'ok');
  });

  $$('[data-setting]').forEach((input) => {
    input.addEventListener('change', async () => {
      const key = input.dataset.setting;
      const value = input.checked;
      state.settings[key] = value;
      await setSettings({ [key]: value });
      if (key === 'autoSave' || key === 'trackIncognito') {
        await refreshData({ sync: true });
      }
    });
  });

  $('#themePicker').addEventListener('click', (event) => {
    const button = event.target.closest('[data-theme-choice]');
    if (!button) return;
    setTheme(button.dataset.themeChoice);
  });

  $('#exportAllBtn').addEventListener('click', () => exportGroups(state.groups));
  $('#importSettingsBtn').addEventListener('click', () => $('#importFile').click());
  $('#clearDataBtn').addEventListener('click', clearAllData);
}

async function openSettings() {
  $$('[data-setting]').forEach((input) => {
    input.checked = Boolean(state.settings[input.dataset.setting]);
  });
  markThemePicker();

  const allowed = await isIncognitoAllowed();
  const status = $('#incognitoStatus');
  status.classList.toggle('off', !allowed);
  const copy = status.querySelector('.incognito-copy');
  if (copy) {
    copy.textContent = allowed
      ? 'Incognito access is enabled.'
      : 'Incognito access is disabled.';
  }
  els.settingsDialog.showModal();
}

/* ------------------------------------------------------------------ */
/* New group / import / export                                         */
/* ------------------------------------------------------------------ */

function openNewGroupMenu(anchor) {
  closeTabPicker();
  const windowTabs = state.tabs.filter((tab) => tab.windowId === state.currentWindowId);
  const selected = selectedTabData();

  const items = [
    {
      label: 'Save this window',
      icon: 'save',
      desc: plural(windowTabs.length, 'tab'),
      disabled: windowTabs.length === 0,
      onSelect: saveCurrentWindow,
    },
  ];

  if (selected.length) {
    items.push({
      label: `Save ${plural(selected.length, 'selected tab')}`,
      icon: 'check',
      onSelect: saveSelectedTabs,
    });
  }

  items.push(
    {
      label: 'Pick tabs to save',
      icon: 'tab',
      desc: 'Checkboxes · drag to select a run',
      onSelect: () => openTabPicker($('#newGroupBtn')),
    },
    { type: 'sep' },
    { label: 'Import from JSON', icon: 'upload', onSelect: () => $('#importFile').click() },
  );

  openMenu(anchor, items);
}

/* ------------------------------------------------------------------ */
/* Tab picker                                                          */
/* ------------------------------------------------------------------ */

function getPickerTabs() {
  const query = pickerQuery.trim().toLowerCase();
  const windowRank = new Map(state.windows.map((win, index) => [win.id, index]));
  return state.tabs
    .filter((tab) => {
      if (!query) return true;
      return (
        tab.title.toLowerCase().includes(query) ||
        (tab.url || '').toLowerCase().includes(query) ||
        tabGroupName(tab.groupId).toLowerCase().includes(query)
      );
    })
    .sort(
      (a, b) =>
        (windowRank.get(a.windowId) ?? 0) - (windowRank.get(b.windowId) ?? 0) ||
        a.index - b.index,
    );
}

function pickerTabData() {
  return state.tabs.filter((tab) => pickerSelection.has(tab.id));
}

function renderPickerRow(tab) {
  const selected = pickerSelection.has(tab.id);
  const pinned = tab.pinned
    ? `<span class="pin-indicator">${icon('pin', 9)} Pinned</span>`
    : '';
  const bits = [windowLabel(tab.windowId)];
  if (tab.groupId !== GROUP_NONE) bits.push(tabGroupName(tab.groupId));
  const host = hostOf(tab.url);
  if (host) bits.push(host);

  return `
    <div class="picker-row ${selected ? 'is-selected' : ''}" role="checkbox" aria-checked="${selected}" tabindex="0" data-tab-id="${tab.id}" aria-label="Select ${escapeAttr(tab.title)}">
      <input type="checkbox" tabindex="-1" aria-hidden="true" ${selected ? 'checked' : ''} />
      ${faviconHtml(tab.url, tab.favIconUrl)}
      <span class="picker-text">
        <span class="picker-title"><span>${escapeHtml(tab.title)}</span>${pinned}</span>
        <span class="picker-sub">${escapeHtml(bits.join(' · '))}</span>
      </span>
    </div>`;
}

function paintPickerRow(row, id) {
  if (!row) return;
  const on = pickerSelection.has(id);
  row.classList.toggle('is-selected', on);
  row.setAttribute('aria-checked', String(on));
  const input = row.querySelector('input[type="checkbox"]');
  if (input) input.checked = on;
}

function togglePickerTab(id) {
  if (pickerSelection.has(id)) pickerSelection.delete(id);
  else pickerSelection.add(id);
  paintPickerRow(els.pickerList.querySelector(`.picker-row[data-tab-id="${id}"]`), id);
  updatePickerChrome();
}

/**
 * Row index a Shift-click range should start from. Uses the last anchored row;
 * for a first Shift-click it starts at the tab currently active in Chrome.
 */
function pickerRangeStart(rows, fallbackIndex) {
  const rowIndexFor = (tabId) =>
    rows.findIndex((row) => Number(row.dataset.tabId) === tabId);
  if (pickerAnchorId != null) {
    const anchored = rowIndexFor(pickerAnchorId);
    if (anchored >= 0) return anchored;
  }
  const preferred =
    state.tabs.find((tab) => tab.active) ||
    state.tabs.find((tab) => tab.id === state.lastActiveTabId) ||
    state.tabs.reduce(
      (best, tab) => (tab.lastAccessed > (best?.lastAccessed ?? -1) ? tab : best),
      null,
    );
  if (preferred) {
    const index = rowIndexFor(preferred.id);
    if (index >= 0) return index;
  }
  return fallbackIndex;
}

function updatePickerChrome() {
  const visible = getPickerTabs();
  const selectedVisible = visible.filter((tab) => pickerSelection.has(tab.id)).length;
  const selectAll = $('#pickerSelectAll');
  selectAll.disabled = visible.length === 0;
  selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;

  const selected = pickerTabData();
  const windows = new Set(selected.map((tab) => tab.windowId));
  $('#pickerCount').textContent = `${selected.length} selected`;
  $('#pickerNote').textContent = selected.length
    ? `${plural(selected.length, 'tab')} across ${plural(windows.size, 'window')}`
    : 'Nothing selected yet';
  $('#pickerSave').disabled = selected.length === 0;
  $('#pickerSave').textContent = selected.length
    ? `Save & group ${plural(selected.length, 'tab')}`
    : 'Save & group';
  $('#pickerGroup').disabled = selected.length === 0;
}

function renderPicker() {
  const tabs = getPickerTabs();
  els.pickerList.innerHTML = tabs.map((tab) => renderPickerRow(tab)).join('');
  els.pickerList.hidden = tabs.length === 0;
  els.pickerEmpty.hidden = tabs.length > 0;
  updatePickerChrome();
}

function positionTabPicker() {
  const picker = els.tabPicker;
  if (!picker || picker.hidden) return;
  const anchor = pickerAnchor?.getBoundingClientRect
    ? pickerAnchor.getBoundingClientRect()
    : null;
  picker.style.visibility = 'hidden';
  picker.style.left = '0px';
  picker.style.top = '0px';

  const width = picker.offsetWidth;
  const height = picker.offsetHeight;
  let left = anchor ? anchor.right - width : window.innerWidth - width - 12;
  left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
  let top = anchor ? anchor.bottom + 8 : 12;
  if (top + height > window.innerHeight - 12) {
    top = anchor ? Math.max(12, anchor.top - height - 8) : Math.max(12, window.innerHeight - height - 12);
  }

  picker.style.left = `${Math.round(left)}px`;
  picker.style.top = `${Math.round(top)}px`;
  picker.style.visibility = '';
}

function openTabPicker(anchor = $('#newGroupBtn')) {
  closeMenu();
  const picker = els.tabPicker;
  pickerAnchor = anchor;
  pickerQuery = '';
  $('#pickerSearch').value = '';

  if (picker.hidden) {
    // Carry over tabs already checked in the Open tabs view.
    pickerSelection = new Set(
      state.tabs.filter((tab) => state.selectedTabs.has(tab.id)).map((tab) => tab.id),
    );
  }

  picker.hidden = false;
  renderPicker();
  positionTabPicker();
  picker.classList.add('open');
  pickerAnchorId = null;
  $('#pickerSearch').focus();

  setTimeout(() => {
    if (picker.hidden) return;
    document.addEventListener('pointerdown', pickerPointerDown, true);
    document.addEventListener('keydown', pickerKeyDown, true);
    window.addEventListener('resize', positionTabPicker);
    window.addEventListener('scroll', pickerScroll, true);
  }, 0);
}

function closeTabPicker({ restoreFocus = false } = {}) {
  const picker = els.tabPicker;
  if (!picker || picker.hidden) return;
  picker.classList.remove('open');
  picker.hidden = true;
  pickerAnchor = null;
  pickerAnchorId = null;
  document.removeEventListener('pointerdown', pickerPointerDown, true);
  document.removeEventListener('keydown', pickerKeyDown, true);
  window.removeEventListener('resize', positionTabPicker);
  window.removeEventListener('scroll', pickerScroll, true);
  if (restoreFocus) $('#newGroupBtn').focus();
}

function pickerPointerDown(event) {
  if (document.querySelector('dialog[open]')) return;
  if (els.tabPicker.contains(event.target)) return;
  if ($('#newGroupBtn').contains(event.target)) return;
  if ($('#newGroupMenuBtn').contains(event.target)) return;
  closeTabPicker();
}

function pickerScroll(event) {
  if (els.tabPicker.contains(event.target)) return;
  closeTabPicker();
}

function pickerKeyDown(event) {
  if (event.key !== 'Escape') return;
  if (document.querySelector('dialog[open]')) return;
  event.stopPropagation();
  closeTabPicker({ restoreFocus: true });
}

async function savePickerTabs() {
  await saveTabsAsGroup(pickerTabData(), { closePicker: true });
}

/** Save the tabs as a plain snapshot; Chrome's tab bar is left untouched. */
async function saveTabsAsSnapshot(tabs, { closePicker = false } = {}) {
  if (!tabs.length) return;
  const windows = new Set(tabs.map((tab) => tab.windowId));

  const result = await askGroup({
    title: 'Save snapshot',
    subtitle: `${plural(tabs.length, 'tab')} from ${plural(windows.size, 'window')} will be saved without changing Chrome.`,
    name: suggestGroupName(tabs),
    color: 'blue',
    confirmText: 'Save snapshot',
    dated: true,
  });
  if (!result) return;

  const collection = await saveTabsAsCollection(tabs, {
    name: result.name,
    color: result.color,
    source: 'manual',
  });
  state.selectedTabs.clear();
  state.lastTabIndex = null;
  state.expanded.add(collection.id);
  state.view = 'groups';
  if (closePicker) closeTabPicker();
  updateViewChrome();
  await refreshData({ sync: false });
  showToast(`Saved ${plural(collection.tabs.length, 'tab')} as a snapshot.`, {
    tone: 'success',
  });
}

async function snapshotPickerTabs() {
  await saveTabsAsSnapshot(pickerTabData(), { closePicker: true });
}

function wireTabPicker() {
  $('#pickerClose').addEventListener('click', () => closeTabPicker({ restoreFocus: true }));

  $('#pickerSearch').addEventListener('input', (event) => {
    pickerQuery = event.target.value;
    renderPicker();
  });

  $('#pickerSelectAll').addEventListener('change', (event) => {
    const tabs = getPickerTabs();
    tabs.forEach((tab) => {
      if (event.target.checked) pickerSelection.add(tab.id);
      else pickerSelection.delete(tab.id);
    });
    renderPicker();
  });

  $('#pickerSave').addEventListener('click', () => {
    savePickerTabs().catch((error) => {
      console.error('[TabStash] Save from picker failed', error);
      showToast('Could not save those tabs.', { tone: 'error' });
    });
  });

  $('#pickerGroup').addEventListener('click', () => {
    snapshotPickerTabs().catch((error) => {
      console.error('[TabStash] Snapshot from picker failed', error);
      showToast('Could not save those tabs.', { tone: 'error' });
    });
  });

  els.pickerList.addEventListener('keydown', (event) => {
    const row = event.target.closest('.picker-row');
    if (!row) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      togglePickerTab(Number(row.dataset.tabId));
      pickerAnchorId = Number(row.dataset.tabId);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const rows = [...els.pickerList.querySelectorAll('.picker-row')];
      const index = rows.indexOf(row);
      const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
      next?.focus();
    }
  });

  els.pickerList.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.shiftKey) return;
    const started = beginDragSelection(event, {
      root: els.pickerList,
      rowSelector: '.picker-row',
      handleSelector: '.picker-row',
      getRows: () => [...els.pickerList.querySelectorAll('.picker-row')],
      isSelected: (id) => pickerSelection.has(Number(id)),
      apply: (id, value, rowEl) => {
        const tabId = Number(id);
        if (value) pickerSelection.add(tabId);
        else pickerSelection.delete(tabId);
        paintPickerRow(rowEl, tabId);
      },
      onChange: updatePickerChrome,
      onFinish: () => {
        setTimeout(() => {
          pickerClickGuard = false;
        }, 0);
      },
    });
    if (started) {
      pickerClickGuard = true;
      pickerAnchorId = Number(event.target.closest('.picker-row')?.dataset.tabId);
    }
  });

  els.pickerList.addEventListener('click', (event) => {
    const row = event.target.closest('.picker-row');
    if (!row) return;
    if (pickerClickGuard) {
      pickerClickGuard = false;
      event.preventDefault();
      return;
    }
    const rows = [...els.pickerList.querySelectorAll('.picker-row')];
    const index = rows.indexOf(row);
    const id = Number(row.dataset.tabId);
    if (event.shiftKey) {
      const value = !pickerSelection.has(id);
      const anchorIndex = pickerRangeStart(rows, index);
      const from = Math.min(anchorIndex, index);
      const to = Math.max(anchorIndex, index);
      for (let i = from; i <= to; i += 1) {
        const target = rows[i];
        if (!target) continue;
        const targetId = Number(target.dataset.tabId);
        if (value) pickerSelection.add(targetId);
        else pickerSelection.delete(targetId);
        paintPickerRow(target, targetId);
      }
      updatePickerChrome();
    } else {
      togglePickerTab(id);
    }
    pickerAnchorId = id;
  });
}

function exportGroups(groups) {
  if (!groups.length) {
    showToast('Nothing to export.', { tone: 'warning' });
    return;
  }
  const payload = {
    app: 'TabStash',
    version: 1,
    exportedAt: new Date().toISOString(),
    groups: groups.map((group) => ({
      name: group.name,
      color: group.color,
      note: group.note,
      createdAt: group.createdAt,
      tabs: group.tabs.map((tab) => ({
        url: tab.url,
        title: tab.title,
        pinned: tab.pinned,
      })),
    })),
  };
  const filename =
    groups.length === 1
      ? `tabstash-${slugify(groups[0].name)}.json`
      : `tabstash-groups-${new Date().toISOString().slice(0, 10)}.json`;
  downloadJson(filename, payload);
  showToast(`Exported ${plural(groups.length, 'group')}.`, { tone: 'success' });
}

async function importFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const raw = Array.isArray(data) ? data : Array.isArray(data.groups) ? data.groups : [];
    const collections = [];

    for (const item of raw) {
      if (!item || typeof item !== 'object' || !Array.isArray(item.tabs)) continue;
      const tabs = item.tabs
        .map((tab) => {
          if (typeof tab === 'string') return { url: tab, title: tab, pinned: false };
          if (!tab || typeof tab.url !== 'string') return null;
          return {
            url: tab.url,
            title: String(tab.title || tab.url),
            pinned: Boolean(tab.pinned),
          };
        })
        .filter(Boolean);
      if (!tabs.length) continue;
      collections.push(
        createCollection({
          name: String(item.name || 'Imported group').slice(0, 160),
          color: item.color,
          tabs,
          note: typeof item.note === 'string' ? item.note : '',
          source: 'manual',
        }),
      );
    }

    if (!collections.length) throw new Error('No groups in file');

    await updateGroups((groups) => [...collections, ...groups]);
    state.view = 'groups';
    updateViewChrome();
    await refreshData({ sync: false });
    showToast(`Imported ${plural(collections.length, 'group')}.`, { tone: 'success' });
  } catch (error) {
    console.error('[TabStash] Import failed', error);
    showToast('That file is not a valid TabStash export.', { tone: 'error' });
  }
}

async function clearAllData() {
  const ok = await confirmDialog({
    title: 'Delete everything?',
    body: 'This removes every saved group and all TabStash data from this device.',
    note: 'Open Chrome tab groups and tabs are not closed.',
    confirmText: 'Delete everything',
    danger: true,
  });
  if (!ok) return;
  await updateGroups(() => []);
  await setIgnored(state.chromeGroups.map((group) => group.id));
  state.selectedGroups.clear();
  state.selectedTabs.clear();
  state.expanded.clear();
  await refreshData({ sync: false });
  showToast('TabStash data cleared.', { tone: 'success' });
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

function wireKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (activeMenu) return;
      if (document.querySelector('dialog[open]')) return;
      if (state.selectedGroups.size || state.selectedTabs.size) {
        event.preventDefault();
        clearSelection();
      }
      return;
    }

    const tag = event.target.tagName;
    const typing =
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      event.target.isContentEditable;

    if (
      event.key === '/' &&
      !typing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      if (state.view === 'groups') {
        els.groupSearch.focus();
        els.groupSearch.select();
      } else {
        els.tabSearch.focus();
        els.tabSearch.select();
      }
      return;
    }

    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.key.toLowerCase() === 'a' &&
      !typing
    ) {
      event.preventDefault();
      if (state.view === 'groups') {
        getVisibleGroups().forEach((group) => state.selectedGroups.add(group.id));
        renderGroups();
      } else {
        getVisibleTabs().forEach((tab) => state.selectedTabs.add(tab.id));
        renderTabs();
      }
      renderSelectionBar();
    }
  });
}

/* ------------------------------------------------------------------ */

init().catch((error) => {
  console.error('[TabStash] Init failed', error);
});
