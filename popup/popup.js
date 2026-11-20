import {
  COLOR_HEX,
  TAB_GROUP_COLORS,
  datedGroupName,
  escapeHtml,
  faviconSrc,
  formatDay,
  getGroups,
  getSettings,
  hostOf,
  plural,
  topDomains,
  updateGroups,
  validColor,
} from '../shared/store.js';
import {
  closeCollectionTabs,
  deleteCollections,
  focusCollection,
  openCollections,
  saveTabsAsChromeGroup,
  saveTabsAsCollection,
  ungroupCollection,
} from '../shared/actions.js';
import { BRAND_MARK, icon } from '../shared/icons.js';
import { beginDragSelection } from '../shared/drag-select.js';

const GROUP_NONE = -1;

const state = {
  groups: [],
  settings: { skipExisting: true, theme: 'auto' },
  liveGroupIds: new Set(),
  windowTabs: [],
  allTabs: [],
  windows: [],
  windowLabels: new Map(),
  groupMetaById: new Map(),
  currentWindowId: null,
  search: '',
  statusFilter: 'all',
};

const picker = {
  query: '',
  selection: new Set(),
  color: 'blue',
  anchorId: null,
  clickGuard: false,
  nameTouched: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const OWN_PREFIX = chrome.runtime.getURL('');

function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach((node) => {
    const svg = icon(node.dataset.icon, Number(node.dataset.size) || 16);
    if (svg) node.outerHTML = svg;
  });
}

function isUsableTab(tab) {
  const url = tab.url || tab.pendingUrl || '';
  if (!url || url === 'chrome://newtab/') return false;
  return !url.startsWith(OWN_PREFIX);
}

function isLive(group) {
  return Boolean(group?.link?.groupId != null && state.liveGroupIds.has(group.link.groupId));
}

async function init() {
  hydrateIcons();
  $('[data-brand]').innerHTML = BRAND_MARK;

  try {
    state.settings = await getSettings();
  } catch {
    /* defaults */
  }
  document.documentElement.dataset.theme = state.settings.theme || 'auto';

  wireDialogs();
  wireEvents();
  await refresh();

  requestBackgroundSync()
    .then(() => refresh())
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ts_groups) refresh();
  });
}

async function requestBackgroundSync() {
  try {
    return await chrome.runtime.sendMessage({ type: 'tabstash:sync' });
  } catch {
    return null;
  }
}

async function refresh() {
  try {
    const [groups, settings, tabs, windows, chromeGroups, currentWindow] = await Promise.all([
      getGroups(),
      getSettings(),
      chrome.tabs.query({}),
      chrome.windows.getAll({ populate: false }),
      chrome.tabGroups.query({}),
      chrome.windows.getCurrent().catch(() => null),
    ]);

    state.groups = groups;
    state.settings = settings;
    state.currentWindowId = currentWindow?.id ?? null;

    const hiddenWindowIds = new Set(
      windows
        .filter(
          (win) =>
            win.incognito &&
            win.id !== state.currentWindowId &&
            !state.settings.trackIncognito,
        )
        .map((win) => win.id),
    );
    state.windows = windows.filter((win) => !hiddenWindowIds.has(win.id));
    state.windowLabels = new Map(
      state.windows.map((win, index) => [
        win.id,
        win.id === state.currentWindowId ? 'This window' : `Window ${index + 1}`,
      ]),
    );
    state.groupMetaById = new Map(
      chromeGroups
        .filter((group) => !hiddenWindowIds.has(group.windowId))
        .map((group) => [group.id, group]),
    );
    state.liveGroupIds = new Set(state.groupMetaById.keys());

    state.allTabs = tabs.filter(
      (tab) => !hiddenWindowIds.has(tab.windowId) && isUsableTab(tab),
    );

    if (state.currentWindowId != null) {
      state.windowTabs = state.allTabs.filter(
        (tab) => tab.windowId === state.currentWindowId,
      );
    } else {
      state.windowTabs = [];
    }

    prunePickerSelection();
    render();
    if (isPicking()) renderPicker();
  } catch (error) {
    console.error('[TabStash] Popup refresh failed', error);
    showToast('Could not read tabs.', { tone: 'error' });
  }
}

function getVisibleGroups() {
  const query = state.search.trim().toLowerCase();
  let groups = state.groups.slice();

  if (state.statusFilter === 'live') groups = groups.filter(isLive);
  else if (state.statusFilter === 'saved') groups = groups.filter((group) => !isLive(group));

  if (query) {
    groups = groups.filter(
      (group) =>
        group.name.toLowerCase().includes(query) ||
        group.tabs.some(
          (tab) =>
            tab.title.toLowerCase().includes(query) || tab.url.toLowerCase().includes(query),
        ),
    );
  }

  groups.sort(
    (a, b) => Number(isLive(b)) - Number(isLive(a)) || b.updatedAt - a.updatedAt,
  );
  return groups;
}

function render() {
  const groups = getVisibleGroups();
  const list = $('#groupList');
  const empty = $('#empty');

  list.innerHTML = groups.map((group) => renderGroup(group)).join('');
  list.hidden = groups.length === 0;
  empty.hidden = groups.length > 0;

  if (!groups.length) {
    const hasFilters = state.search.trim() || state.statusFilter !== 'all';
    $('#emptyTitle').textContent = hasFilters ? 'No groups match' : 'No saved groups yet';
    $('#emptyText').textContent = hasFilters
      ? 'Try another search or filter.'
      : 'Save this window to start building your library.';
  }

  $$('#statusFilter button').forEach((button) => {
    button.classList.toggle('active', button.dataset.status === state.statusFilter);
  });
}

function renderGroup(group) {
  const live = isLive(group);
  const domains = topDomains(group.tabs, 3);
  const metaParts = [plural(group.tabs.length, 'tab')];
  if (domains.total) metaParts.push(plural(domains.total, 'site'));
  const meta = metaParts.join(' · ');
  const liveHtml = live
    ? `<span class="pop-meta-sep">·</span><span class="pop-live">Open</span>`
    : '';

  return `
    <div class="pop-group ${live ? 'is-live' : ''}" data-id="${escapeHtml(group.id)}">
      <button class="pop-group-main" type="button" data-action="${live ? 'focus' : 'current'}" title="${live ? 'Focus open group' : 'Open in this window'}">
        <span class="pop-dot" style="--dot:${COLOR_HEX[validColor(group.color)]}"></span>
        <span class="pop-group-text">
          <span class="pop-name">${escapeHtml(group.name)}</span>
          <span class="pop-meta">${meta}${liveHtml}</span>
        </span>
      </button>
      <div class="pop-quick">
        <button class="icon-btn" type="button" data-action="current" title="Open in this window" aria-label="Open in this window">${icon('monitor', 15)}</button>
        <button class="icon-btn" type="button" data-action="window" title="Open in new window" aria-label="Open in new window">${icon('window', 15)}</button>
        <button class="icon-btn" type="button" data-action="incognito" title="Open in incognito" aria-label="Open in incognito">${icon('incognito', 15)}</button>
        <button class="icon-btn pop-group-more" type="button" data-action="more" title="Rename, close, ungroup, delete" aria-label="More actions for ${escapeHtml(group.name)}" aria-haspopup="menu">${icon('dots', 15)}</button>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Tab picker                                                          */
/* ------------------------------------------------------------------ */

function isPicking() {
  return document.body.classList.contains('picking');
}

function windowLabel(windowId) {
  return state.windowLabels.get(windowId) || 'Window';
}

function groupLabel(groupId) {
  if (groupId === GROUP_NONE || groupId == null) return 'Ungrouped';
  const group = state.groupMetaById.get(groupId);
  if (!group || !group.title) return 'Untitled group';
  return group.title;
}

function hueFor(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = value.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function faviconHtml(url, fallback = '') {
  const host = hostOf(url);
  const letter = escapeHtml((host[0] || '?').toUpperCase());
  const hue = hueFor(host || url || 'x');
  const src = faviconSrc(url, fallback, 64);
  const tint = `color-mix(in srgb, hsl(${hue} 66% 56%) 18%, var(--surface))`;
  return `<span class="pop-fav" style="--tint:${tint}"><span>${letter}</span><img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`;
}

function getPickerTabs() {
  const query = picker.query.trim().toLowerCase();
  const windowRank = new Map(state.windows.map((win, index) => [win.id, index]));
  return state.allTabs
    .filter((tab) => {
      if (!query) return true;
      return (
        tab.title.toLowerCase().includes(query) ||
        (tab.url || '').toLowerCase().includes(query) ||
        groupLabel(tab.groupId).toLowerCase().includes(query)
      );
    })
    .sort(
      (a, b) =>
        (windowRank.get(a.windowId) ?? 0) - (windowRank.get(b.windowId) ?? 0) ||
        a.index - b.index,
    );
}

function selectedPickerTabs() {
  return state.allTabs.filter((tab) => picker.selection.has(tab.id));
}

function suggestedPickerName(tabs) {
  const hosts = [...new Set(tabs.map((tab) => hostOf(tab.url)).filter(Boolean))];
  if (hosts.length === 1) return hosts[0];
  return 'Selected tabs';
}

function refreshPickerName(tabs = selectedPickerTabs()) {
  if (picker.nameTouched) return;
  $('#pickerName').value = tabs.length ? suggestedPickerName(tabs) : '';
}

function renderPickerRow(tab) {
  const selected = picker.selection.has(tab.id);
  const pinned = tab.pinned
    ? `<span class="pin-indicator">${icon('pin', 8)} Pinned</span>`
    : '';
  const bits = [windowLabel(tab.windowId)];
  if (tab.groupId !== GROUP_NONE && tab.groupId != null) bits.push(groupLabel(tab.groupId));
  const host = hostOf(tab.url);
  if (host) bits.push(host);

  return `
    <div class="picker-row ${selected ? 'is-selected' : ''}" role="checkbox" aria-checked="${selected}" tabindex="0" data-tab-id="${tab.id}" aria-label="Select ${escapeHtml(tab.title)}">
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
  const on = picker.selection.has(id);
  row.classList.toggle('is-selected', on);
  row.setAttribute('aria-checked', String(on));
  const input = row.querySelector('input[type="checkbox"]');
  if (input) input.checked = on;
}

function togglePickerTab(id) {
  if (picker.selection.has(id)) picker.selection.delete(id);
  else picker.selection.add(id);
  paintPickerRow($(`.picker-row[data-tab-id="${id}"]`, $('#pickerList')), id);
  updatePickerChrome();
}

/**
 * Row index a Shift-click range should start from. Uses the last anchored row;
 * for a first Shift-click it starts at the tab currently active in Chrome.
 */
function pickerRangeStart(rows, fallbackIndex) {
  const rowIndexFor = (tabId) =>
    rows.findIndex((row) => Number(row.dataset.tabId) === tabId);
  if (picker.anchorId != null) {
    const anchored = rowIndexFor(picker.anchorId);
    if (anchored >= 0) return anchored;
  }
  const preferred =
    state.allTabs.find((tab) => tab.active) ||
    state.allTabs.reduce(
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
  const selectedVisible = visible.filter((tab) => picker.selection.has(tab.id)).length;
  const selectAll = $('#pickerSelectAll');
  selectAll.disabled = visible.length === 0;
  selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;

  const selected = selectedPickerTabs();
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
  refreshPickerName(selected);
}

function renderPicker() {
  const tabs = getPickerTabs();
  $('#pickerList').innerHTML = tabs.map((tab) => renderPickerRow(tab)).join('');
  $('#pickerList').hidden = tabs.length === 0;
  $('#pickerEmpty').hidden = tabs.length > 0;
  updatePickerChrome();
}

function renderPickerColors() {
  const host = $('#pickerColors');
  host.innerHTML = TAB_GROUP_COLORS.map(
    (color) =>
      `<button type="button" data-color="${color.name}" class="${color.name === picker.color ? 'active' : ''}" style="--dot:${color.hex}" title="${color.name}" aria-label="${color.name}" aria-pressed="${color.name === picker.color}"></button>`,
  ).join('');
}

function prunePickerSelection() {
  const ids = new Set(state.allTabs.map((tab) => tab.id));
  let changed = false;
  for (const id of picker.selection) {
    if (!ids.has(id)) {
      picker.selection.delete(id);
      changed = true;
    }
  }
  if (changed) picker.anchorId = null;
}

function openPicker() {
  hideMenu();
  document.body.classList.add('picking');
  $('#tabPicker').hidden = false;
  picker.query = '';
  $('#pickerSearch').value = '';
  picker.anchorId = null;
  picker.nameTouched = false;
  $('#pickerNameSuffix').textContent = `· ${formatDay()}`;
  renderPickerColors();
  renderPicker();
  $('#pickerSearch').focus();
}

function closePicker({ restoreFocus = false } = {}) {
  if (!isPicking()) return;
  hideMenu();
  document.body.classList.remove('picking');
  $('#tabPicker').hidden = true;
  picker.anchorId = null;
  if (restoreFocus) $('#newGroupBtn').focus();
}

function resetPicker() {
  picker.selection.clear();
  picker.nameTouched = false;
  picker.anchorId = null;
  $('#pickerName').value = '';
  picker.color = 'blue';
}

async function savePickerTabs() {
  const tabs = selectedPickerTabs();
  if (!tabs.length) return;
  const name = datedGroupName(
    $('#pickerName').value.trim() || suggestedPickerName(tabs),
  );

  try {
    const { groupIds, skipped } = await saveTabsAsChromeGroup(tabs, {
      name,
      color: picker.color,
      source: 'manual',
    });
    resetPicker();
    closePicker();
    await refresh();
    if (groupIds.length) {
      const grouped = tabs.length - skipped;
      showToast(
        skipped
          ? `Saved & grouped ${plural(grouped, 'tab')}. ${plural(skipped, 'pinned tab')} stayed ungrouped.`
          : `Saved & grouped ${plural(grouped, 'tab')}.`,
        {
          tone: 'success',
          duration: 3600,
          action: { label: 'Open dashboard', onClick: openDashboard },
        },
      );
    } else {
      showToast('Saved as a snapshot — pinned tabs cannot be grouped.', {
        tone: 'warning',
        duration: 3600,
        action: { label: 'Open dashboard', onClick: openDashboard },
      });
    }
  } catch (error) {
    console.error('[TabStash] Save from picker failed', error);
    showToast('Could not save those tabs.', { tone: 'error' });
  }
}

async function snapshotPickerTabs() {
  const tabs = selectedPickerTabs();
  if (!tabs.length) return;
  const name = datedGroupName(
    $('#pickerName').value.trim() || suggestedPickerName(tabs),
  );

  try {
    await saveTabsAsCollection(tabs, {
      name,
      color: picker.color,
      source: 'manual',
    });
    resetPicker();
    closePicker();
    await refresh();
    showToast(`Saved ${plural(tabs.length, 'tab')} as a snapshot.`, {
      tone: 'success',
      duration: 3600,
      action: { label: 'Open dashboard', onClick: openDashboard },
    });
  } catch (error) {
    console.error('[TabStash] Snapshot from picker failed', error);
    showToast('Could not save those tabs.', { tone: 'error' });
  }
}

async function openGroup(group, mode) {
  try {
    const result = await openCollections([group], {
      mode,
      skipExisting: state.settings.skipExisting,
    });
    if (!result.opened) {
      showToast('Those tabs are already open in this window.', { tone: 'warning' });
      return;
    }
    window.close();
  } catch (error) {
    if (error?.code === 'INCOGNITO_DISABLED') {
      showIncognitoHelp();
    } else {
      console.error('[TabStash] Could not open group', error);
      showToast('Could not open that group.', { tone: 'error' });
    }
  }
}

async function focusGroup(group) {
  const focused = await focusCollection(group);
  if (focused) {
    window.close();
  } else {
    showToast('That Chrome group is no longer open.', { tone: 'warning' });
    await refresh();
  }
}

async function renameGroup(group) {
  const name = await askRename(group);
  if (!name || name === group.name) return;

  await updateGroups((groups) => {
    const found = groups.find((item) => item.id === group.id);
    if (found) {
      found.name = name;
      found.updatedAt = Date.now();
    }
    return groups;
  });

  if (isLive(group)) {
    try {
      await chrome.tabGroups.update(group.link.groupId, { title: name });
    } catch {
      /* the Chrome group may have just closed */
    }
  }

  await refresh();
  showToast('Group renamed.', { tone: 'success' });
}

async function closeGroupTabs(group) {
  const ok = await askConfirm({
    title: 'Close all tabs?',
    body: `This closes ${plural(group.tabs.length, 'tab')} in the open Chrome group. The saved group stays in your library.`,
    confirmText: 'Close tabs',
    danger: true,
  });
  if (!ok) return;

  const done = await closeCollectionTabs(group);
  await refresh();
  showToast(
    done ? 'Tabs closed. The group was saved.' : 'Those tabs were already closed.',
    { tone: done ? 'success' : 'warning' },
  );
}

async function ungroupGroup(group) {
  const ok = await askConfirm({
    title: 'Ungroup in Chrome?',
    body: `The ${plural(group.tabs.length, 'tab')} stay open, but Chrome will no longer group them.`,
    confirmText: 'Ungroup',
    danger: false,
  });
  if (!ok) return;

  const done = await ungroupCollection(group);
  await refresh();
  showToast(done ? 'Chrome group removed.' : 'That group was already ungrouped.', {
    tone: done ? 'success' : 'warning',
  });
}

async function deleteGroup(group) {
  const live = isLive(group);
  const ok = await askConfirm({
    title: `Delete “${group.name}”?`,
    body: `This removes ${plural(group.tabs.length, 'tab')} from your saved library.`,
    note: live ? 'The Chrome group tag will be removed too. Its tabs stay open.' : '',
    confirmText: live ? 'Ungroup & remove' : 'Delete',
    danger: true,
  });
  if (!ok) return;

  await deleteCollections([group.id]);
  await refresh();
  showToast(
    live
      ? 'Group removed and ungrouped — tabs are still open.'
      : 'Group removed from library.',
    { tone: 'success' },
  );
}

async function saveWindow() {
  if (!state.windowTabs.length) return;
  const name = datedGroupName('Window');
  try {
    const { groupIds, skipped } = await saveTabsAsChromeGroup(state.windowTabs, {
      name,
      color: 'blue',
      source: 'manual',
    });
    await refresh();
    if (groupIds.length && !skipped) {
      showToast(`Saved & grouped ${plural(state.windowTabs.length, 'tab')}.`, {
        tone: 'success',
        duration: 3200,
        action: { label: 'Open dashboard', onClick: openDashboard },
      });
    } else if (groupIds.length) {
      showToast(
        `Saved & grouped ${plural(state.windowTabs.length - skipped, 'tab')}. ${plural(skipped, 'pinned tab')} stayed ungrouped.`,
        {
          tone: 'success',
          duration: 3200,
          action: { label: 'Open dashboard', onClick: openDashboard },
        },
      );
    } else {
      showToast('Saved as a snapshot — pinned tabs cannot be grouped.', {
        tone: 'warning',
        duration: 3200,
        action: { label: 'Open dashboard', onClick: openDashboard },
      });
    }
  } catch (error) {
    console.error('[TabStash] Save window failed', error);
    showToast('Could not save this window.', { tone: 'error' });
  }
}

async function openDashboard() {
  try {
    await chrome.runtime.sendMessage({ type: 'tabstash:open-dashboard' });
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  }
  window.close();
}

function showIncognitoHelp() {
  showToast(
    'Enable “Allow in Incognito” for TabStash in chrome://extensions → Details.',
    {
      tone: 'warning',
      duration: 7000,
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
  window.close();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

function showToast(message, { tone = 'default', duration = 3200, action = null } = {}) {
  const host = $('#toastHost');
  while (host.children.length >= 2) host.firstElementChild?.remove();

  const element = document.createElement('div');
  element.className = `toast ${tone}`;
  const iconName =
    tone === 'success' ? 'check' : tone === 'error' || tone === 'warning' ? 'alert' : 'info';
  element.innerHTML = `<span class="toast-icon">${icon(iconName, 12)}</span><span class="toast-msg"></span>`;
  element.querySelector('.toast-msg').textContent = message;
  host.append(element);

  const dismiss = () => {
    element.classList.add('hide');
    setTimeout(() => element.remove(), 220);
  };
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.onClick?.();
      dismiss();
    });
    element.append(button);
  }
  setTimeout(dismiss, duration);
}

/* ------------------------------------------------------------------ */
/* Popup menus                                                         */
/* ------------------------------------------------------------------ */

const menuState = {
  items: [],
  anchor: null,
};

function hideMenu() {
  const menu = $('#popMenu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  menu.innerHTML = '';
  menuState.items = [];
  menuState.anchor = null;
  document.removeEventListener('pointerdown', onMenuPointerDown, true);
}

function onMenuPointerDown(event) {
  if ($('#popMenu').contains(event.target)) return;
  if (menuState.anchor?.contains(event.target)) return;
  hideMenu();
}

function renderMenuItem(item, index) {
  if (item.type === 'sep') return '<div class="pop-menu-sep" role="separator"></div>';
  const desc = item.desc
    ? `<span class="pop-menu-desc">${escapeHtml(item.desc)}</span>`
    : '';
  return `
    <button class="pop-menu-item ${item.danger ? 'is-danger' : ''}" type="button" role="menuitem" data-menu-index="${index}" ${item.disabled ? 'disabled' : ''}>
      <span class="icon">${icon(item.icon || 'dots', 15)}</span>
      <span class="pop-menu-text">
        <span>${escapeHtml(item.label)}</span>
        ${desc}
      </span>
    </button>`;
}

function showMenu(anchor, items, { placement = 'above' } = {}) {
  const menu = $('#popMenu');
  menuState.items = items;
  menuState.anchor = anchor;
  menu.innerHTML = items.map(renderMenuItem).join('');

  menu.hidden = false;
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8),
  );
  const top =
    placement === 'below'
      ? Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8)
      : Math.max(8, rect.top - menu.offsetHeight - 8);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = '';

  setTimeout(() => {
    if (menu.hidden) return;
    document.addEventListener('pointerdown', onMenuPointerDown, true);
  }, 0);
}

function showFooterMenu(anchor) {
  const count = state.windowTabs.length;
  showMenu(anchor, [
    {
      label: 'Pick tabs to save',
      icon: 'tab',
      desc: 'Checkboxes · drag to select a run',
      onSelect: openPicker,
    },
    {
      label: 'Save this window',
      icon: 'save',
      desc: count ? `${plural(count, 'tab')} · grouped in Chrome` : 'No tabs to save',
      disabled: !count,
      onSelect: saveWindow,
    },
  ]);
}

function showGroupMenu(anchor, group) {
  const live = isLive(group);
  const items = [
    {
      label: 'Rename',
      icon: 'pencil',
      desc: live ? 'Also updates the Chrome title' : 'Updates the saved name',
      onSelect: () => renameGroup(group),
    },
    { type: 'sep' },
  ];
  if (live) {
    items.push(
      {
        label: 'Close all tabs',
        icon: 'x',
        desc: 'Keeps this saved group',
        onSelect: () => closeGroupTabs(group),
      },
      {
        label: 'Ungroup in Chrome',
        icon: 'layers',
        desc: 'Tabs stay open',
        onSelect: () => ungroupGroup(group),
      },
      { type: 'sep' },
    );
  }
  items.push({
    label: 'Delete group',
    icon: 'trash',
    desc: live ? 'Tabs stay open' : 'Removes it from the library',
    danger: true,
    onSelect: () => deleteGroup(group),
  });
  showMenu(anchor, items, { placement: 'below' });
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

let renameResolver = null;
let confirmResolver = null;

function settleDialog(dialog, ok) {
  if (dialog.id === 'renameDialog') {
    if (!renameResolver) return;
    const resolve = renameResolver;
    renameResolver = null;
    resolve(ok ? $('#renameInput').value.trim() || null : null);
    return;
  }
  if (dialog.id === 'confirmDialog') {
    if (!confirmResolver) return;
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve(ok);
  }
}

function closeDialog(dialog, value) {
  if (!dialog?.open) return;
  dialog.returnValue = value;
  dialog.close(value);
  settleDialog(dialog, value === 'ok');
}

function askRename(group) {
  const dialog = $('#renameDialog');
  if (dialog.open) return Promise.resolve(null);

  return new Promise((resolve) => {
    renameResolver = resolve;
    const input = $('#renameInput');
    input.value = group.name;
    input.classList.remove('invalid');
    $('#renameSub').textContent = isLive(group)
      ? 'Updates the saved name and the Chrome group title.'
      : 'Updates the saved name.';
    $('#renameHint').hidden = true;
    dialog.returnValue = '';
    dialog.showModal();
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

function askConfirm({
  title,
  body,
  note = '',
  confirmText = 'Delete',
  danger = true,
}) {
  const dialog = $('#confirmDialog');
  if (dialog.open) return Promise.resolve(false);

  return new Promise((resolve) => {
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
    button.addEventListener('click', () => {
      closeDialog(button.closest('dialog'), 'cancel');
    });
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
      settleDialog(dialog, dialog.returnValue === 'ok');
    });
  });

  $('#renameForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#renameInput');
    if (!input.value.trim()) {
      input.classList.add('invalid');
      input.focus();
      return;
    }
    closeDialog($('#renameDialog'), 'ok');
  });

  $('#renameInput').addEventListener('input', () => {
    $('#renameInput').classList.remove('invalid');
  });

  $('#confirmForm').addEventListener('submit', (event) => {
    event.preventDefault();
    closeDialog($('#confirmDialog'), 'ok');
  });
}

function wireEvents() {
  $('#search').addEventListener('input', (event) => {
    state.search = event.target.value;
    hideMenu();
    render();
  });

  $('#statusFilter').addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    state.statusFilter = button.dataset.status;
    hideMenu();
    render();
  });

  $('#popBody').addEventListener('scroll', hideMenu, { passive: true });

  $('#groupList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const item = event.target.closest('.pop-group');
    const group = state.groups.find((candidate) => candidate.id === item?.dataset.id);
    if (!group) return;

    switch (button.dataset.action) {
      case 'focus':
        focusGroup(group);
        break;
      case 'current':
        openGroup(group, 'current');
        break;
      case 'window':
        openGroup(group, 'window');
        break;
      case 'incognito':
        openGroup(group, 'incognito');
        break;
      case 'more':
        if (!$('#popMenu').hidden && menuState.anchor === button) hideMenu();
        else showGroupMenu(button, group);
        break;
      default:
        break;
    }
  });

  $('#newGroupBtn').addEventListener('click', openPicker);
  $('#newGroupMenuBtn').addEventListener('click', () => {
    if ($('#popMenu').hidden) showFooterMenu($('#newGroupMenuBtn'));
    else hideMenu();
  });

  $('#popMenu').addEventListener('click', (event) => {
    const button = event.target.closest('[data-menu-index]');
    if (!button) return;
    const entry = menuState.items[Number(button.dataset.menuIndex)];
    hideMenu();
    entry?.onSelect?.();
  });

  $('#pickerClose').addEventListener('click', () => closePicker({ restoreFocus: true }));

  $('#pickerSearch').addEventListener('input', (event) => {
    picker.query = event.target.value;
    renderPicker();
  });

  $('#pickerSelectAll').addEventListener('change', (event) => {
    const tabs = getPickerTabs();
    tabs.forEach((tab) => {
      if (event.target.checked) picker.selection.add(tab.id);
      else picker.selection.delete(tab.id);
    });
    renderPicker();
  });

  $('#pickerName').addEventListener('input', () => {
    picker.nameTouched = true;
  });

  $('#pickerColors').addEventListener('click', (event) => {
    const button = event.target.closest('[data-color]');
    if (!button) return;
    picker.color = validColor(button.dataset.color);
    renderPickerColors();
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

  $('#pickerList').addEventListener('keydown', (event) => {
    const row = event.target.closest('.picker-row');
    if (!row) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      togglePickerTab(Number(row.dataset.tabId));
      picker.anchorId = Number(row.dataset.tabId);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const rows = [...$('#pickerList').querySelectorAll('.picker-row')];
      const index = rows.indexOf(row);
      const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
      next?.focus();
    }
  });

  const pickerList = $('#pickerList');
  pickerList.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.shiftKey) return;
    const row = event.target.closest('.picker-row');
    if (!row) return;
    const started = beginDragSelection(event, {
      root: pickerList,
      rowSelector: '.picker-row',
      handleSelector: '.picker-row',
      getRows: () => [...pickerList.querySelectorAll('.picker-row')],
      isSelected: (id) => picker.selection.has(Number(id)),
      apply: (id, value, rowEl) => {
        const tabId = Number(id);
        if (value) picker.selection.add(tabId);
        else picker.selection.delete(tabId);
        paintPickerRow(rowEl, tabId);
      },
      onChange: updatePickerChrome,
      onFinish: () => {
        setTimeout(() => {
          picker.clickGuard = false;
        }, 0);
      },
    });
    if (!started) return;
    picker.clickGuard = true;
    picker.anchorId = Number(row.dataset.tabId);
  });

  pickerList.addEventListener('click', (event) => {
    const row = event.target.closest('.picker-row');
    if (!row) return;
    if (picker.clickGuard) {
      picker.clickGuard = false;
      event.preventDefault();
      return;
    }
    const rows = [...pickerList.querySelectorAll('.picker-row')];
    const index = rows.indexOf(row);
    const id = Number(row.dataset.tabId);
    if (event.shiftKey) {
      const value = !picker.selection.has(id);
      const anchorIndex = pickerRangeStart(rows, index);
      const from = Math.min(anchorIndex, index);
      const to = Math.max(anchorIndex, index);
      for (let i = from; i <= to; i += 1) {
        const target = rows[i];
        if (!target) continue;
        const targetId = Number(target.dataset.tabId);
        if (value) picker.selection.add(targetId);
        else picker.selection.delete(targetId);
        paintPickerRow(target, targetId);
      }
      updatePickerChrome();
    } else {
      togglePickerTab(id);
    }
    picker.anchorId = id;
  });

  $('#dashboardBtn').addEventListener('click', openDashboard);
  $('#openDashboardBtn').addEventListener('click', openDashboard);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#popMenu').hidden) {
        event.preventDefault();
        hideMenu();
        return;
      }
      if (isPicking()) {
        event.preventDefault();
        closePicker({ restoreFocus: true });
        return;
      }
    }
    if (event.key === '/' && event.target.tagName !== 'INPUT') {
      event.preventDefault();
      if (isPicking()) {
        $('#pickerSearch').focus();
        $('#pickerSearch').select();
      } else {
        $('#search').focus();
        $('#search').select();
      }
    }
    if (event.key === 'Escape' && event.target.id === 'search' && event.target.value) {
      event.preventDefault();
      event.target.value = '';
      state.search = '';
      render();
    }
  });
}

init().catch((error) => {
  console.error('[TabStash] Popup init failed', error);
});
