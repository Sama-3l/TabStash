/**
 * TabStash tab / group actions shared by the dashboard and popup.
 */

import {
  addIgnored,
  createCollection,
  dedupeTabs,
  getIgnored,
  normalizeUrl,
  now,
  setIgnored,
  tabFromChrome,
  updateGroups,
  validColor,
} from './store.js';

export async function isIncognitoAllowed() {
  try {
    return Boolean(await chrome.extension.isAllowedIncognitoAccess());
  } catch {
    return false;
  }
}

export async function getCurrentWindow() {
  return chrome.windows.getCurrent();
}

async function currentWindowId() {
  const win = await getCurrentWindow();
  return win.id;
}

async function focusWindow(windowId) {
  const win = await chrome.windows.get(windowId);
  if (!win) return;
  await chrome.windows.update(windowId, {
    focused: true,
    ...(win.state === 'minimized' ? { state: 'normal' } : {}),
  });
}

async function createTab(windowId, tab, { pin = true } = {}) {
  return chrome.tabs.create({
    url: tab.url,
    windowId,
    active: false,
    pinned: pin && Boolean(tab.pinned),
  });
}

/**
 * Open one or more saved groups.
 *
 * @param {Array} collections saved collections
 * @param {{
 *   mode?: 'current'|'window'|'incognito',
 *   grouped?: boolean,
 *   skipExisting?: boolean,
 * }} options
 */
export async function openCollections(collections, options = {}) {
  const list = (collections || []).filter((c) => c && Array.isArray(c.tabs) && c.tabs.length);
  if (!list.length) return { opened: 0, skipped: 0, groupIds: [] };

  const mode = options.mode || 'current';
  const grouped = options.grouped !== false;
  const skipExisting = Boolean(options.skipExisting);
  const results = { opened: 0, skipped: 0, groupIds: [], windowId: null };

  if (mode === 'incognito' && !(await isIncognitoAllowed())) {
    const err = new Error('incognito-disabled');
    err.code = 'INCOGNITO_DISABLED';
    throw err;
  }

  let windowId = null;
  let isNewWindow = false;
  const seen = new Set();

  if (mode === 'current') {
    windowId = await currentWindowId();
    if (skipExisting) {
      const open = await chrome.tabs.query({ windowId });
      for (const tab of open) seen.add(normalizeUrl(tab.url || tab.pendingUrl || ''));
    }
  } else {
    isNewWindow = true;
  }

  for (const collection of list) {
    let tabs = dedupeTabs(collection.tabs);
    if (skipExisting && mode === 'current') {
      tabs = tabs.filter((t) => {
        const key = normalizeUrl(t.url);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    if (!tabs.length) {
      results.skipped += collection.tabs.length;
      continue;
    }

    let firstTab = null;

    if (isNewWindow && !windowId) {
      const win = await chrome.windows.create({
        url: tabs[0].url,
        incognito: mode === 'incognito',
        focused: true,
      });
      windowId = win.id;
      results.windowId = windowId;
      firstTab = win.tabs && win.tabs[0];
      if (firstTab && tabs[0].pinned && firstTab.id != null) {
        // Pinned tabs cannot join a tab group, so only preserve pinning when ungrouped.
        await chrome.tabs.update(firstTab.id, { pinned: !grouped });
      }
      if (firstTab) results.opened += 1;
      if (skipExisting) seen.add(normalizeUrl(tabs[0].url));
      tabs = tabs.slice(1);
    }

    const created = [];
    if (firstTab && firstTab.id != null) created.push(firstTab);

    for (const tab of tabs) {
      try {
        const createdTab = await createTab(windowId, tab, { pin: !grouped });
        created.push(createdTab);
        results.opened += 1;
      } catch (error) {
        console.warn('[TabStash] Could not open tab', tab.url, error);
      }
    }

    if (!created.length) continue;

    if (grouped) {
      try {
        const tabIds = created.map((t) => t.id).filter((id) => id != null);
        const groupId = await chrome.tabs.group({
          tabIds,
          createProperties: { windowId },
        });
        await chrome.tabGroups.update(groupId, {
          title: collection.name || 'Untitled group',
          color: validColor(collection.color),
          collapsed: false,
        });
        results.groupIds.push(groupId);
        await claimGroup(collection.id, groupId, windowId);
      } catch (error) {
        console.warn('[TabStash] Could not create tab group', error);
      }
    }
  }

  if (isNewWindow && windowId != null) {
    await focusWindow(windowId);
    results.windowId = windowId;
  } else if (windowId != null) {
    await focusWindow(windowId);
  }

  return results;
}

export async function openCollection(collection, options = {}) {
  return openCollections([collection], options);
}

/** Link a freshly created Chrome group to its saved collection. */
export async function claimGroup(collectionId, groupId, windowId) {
  const previousGroupIds = new Set();
  await updateGroups((groups) => {
    const target = groups.find((group) => group.id === collectionId);
    if (!target) return groups;

    if (target.link?.groupId != null && target.link.groupId !== groupId) {
      previousGroupIds.add(target.link.groupId);
    }
    target.link = { groupId, windowId: windowId ?? null };
    target.closedAt = null;
    target.updatedAt = now();

    // Another saved snapshot of the same Chrome group would be a duplicate.
    return groups.filter(
      (group) => group === target || group.link?.groupId !== groupId,
    );
  });
  for (const staleId of previousGroupIds) await addIgnored(staleId);
  await removeIgnoredSafe(groupId);
}

async function removeIgnoredSafe(groupId) {
  const ids = await getIgnored();
  if (ids.includes(groupId)) {
    await setIgnored(ids.filter((id) => id !== groupId));
  }
}

/** Focus an already-open saved group. */
export async function focusCollection(collection) {
  if (!collection?.link?.groupId) return false;
  try {
    const group = await chrome.tabGroups.get(collection.link.groupId);
    const tabs = await chrome.tabs.query({ groupId: group.id });
    if (!tabs.length) return false;
    tabs.sort((a, b) => a.index - b.index);
    if (group.windowId != null) await focusWindow(group.windowId);
    if (group.collapsed) {
      await chrome.tabGroups.update(group.id, { collapsed: false });
    }
    const target = tabs[0];
    await chrome.windows.update(target.windowId, { focused: true });
    await chrome.tabs.update(target.id, { active: true });
    return true;
  } catch {
    return false;
  }
}

/** Remove the Chrome tab group but keep the tabs open. */
export async function ungroupCollection(collection) {
  if (!collection?.link?.groupId) return false;
  try {
    const tabs = await chrome.tabs.query({ groupId: collection.link.groupId });
    if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id));
    await updateGroups((groups) => {
      const found = groups.find((g) => g.id === collection.id);
      if (found) {
        found.link = null;
        found.closedAt = now();
      }
      return groups;
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Group open tabs into Chrome tab groups, grouped by window.
 * Returns the ids of the created groups.
 */
export async function groupChromeTabs(tabIds, { name = 'Untitled group', color = 'blue' } = {}) {
  const ids = [...new Set(tabIds)].filter((id) => typeof id === 'number');
  if (!ids.length) return [];

  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const byWindow = new Map();
  for (const id of ids) {
    const tab = byId.get(id);
    if (!tab || tab.pinned) continue;
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }

  const createdGroupIds = [];
  for (const [windowId, windowTabs] of byWindow) {
    try {
      const groupId = await chrome.tabs.group({
        tabIds: windowTabs.map((t) => t.id),
        createProperties: { windowId },
      });
      await chrome.tabGroups.update(groupId, {
        title: name || 'Untitled group',
        color: validColor(color),
        collapsed: false,
      });
      createdGroupIds.push(groupId);

      // Persist the new group immediately so it appears even if auto-save is off.
      const live = await chrome.tabs.query({ groupId });
      const snapshot = live
        .sort((a, b) => a.index - b.index)
        .map(tabFromChrome)
        .filter(Boolean);
      const collection = createCollection({
        name: name || 'Untitled group',
        color,
        tabs: snapshot,
        source: 'manual',
        link: { groupId, windowId },
      });
      await updateGroups((groups) => {
        const kept = groups.filter((group) => group.link?.groupId !== groupId);
        kept.unshift(collection);
        return kept;
      });
      await removeIgnoredSafe(groupId);
    } catch (error) {
      console.warn('[TabStash] Could not group tabs', error);
    }
  }
  return createdGroupIds;
}

/**
 * Save open tabs as a group that is visible in Chrome's tab bar.
 * Tabs are grouped per window and the resulting collections are linked, so they
 * stay in sync. Pinned tabs (and selections that cannot be grouped) fall back to
 * a plain snapshot.
 */
export async function saveTabsAsChromeGroup(tabs, { name = '', color = 'blue', source = 'manual' } = {}) {
  const list = Array.isArray(tabs) ? tabs : [];
  if (!list.length) return { groupIds: [], snapshot: null, skipped: 0 };

  const groupable = list.filter((tab) => typeof tab.id === 'number' && !tab.pinned);
  const skipped = list.length - groupable.length;
  const groupIds = groupable.length
    ? await groupChromeTabs(groupable.map((tab) => tab.id), { name, color })
    : [];

  if (groupIds.length) return { groupIds, snapshot: null, skipped };

  const snapshot = await saveTabsAsCollection(list, { name, color, source });
  return { groupIds: [], snapshot, skipped };
}

/** Save chrome tabs into a new, closed collection. */
export async function saveTabsAsCollection(tabs, { name = '', color = 'blue', source = 'manual' } = {}) {
  const snapshot = tabs.map(tabFromChrome).filter(Boolean);
  const collection = createCollection({
    name: name || 'Untitled group',
    color,
    tabs: dedupeTabs(snapshot),
    source,
  });
  await updateGroups((groups) => {
    groups.unshift(collection);
    return groups;
  });
  return collection;
}

/**
 * Delete a saved collection. When it is linked to a live Chrome group, remove
 * the Chrome group tag as well while leaving every tab open.
 */
export async function deleteCollections(ids) {
  const idSet = new Set(ids);
  const liveGroupIds = [];
  await updateGroups((groups) =>
    groups.filter((group) => {
      if (!idSet.has(group.id)) return true;
      if (group.link?.groupId != null) liveGroupIds.push(group.link.groupId);
      return false;
    }),
  );
  for (const groupId of liveGroupIds) {
    // Mark it ignored first so the background cannot re-create the snapshot
    // while the ungroup call is in flight.
    await addIgnored(groupId);
    try {
      const tabs = await chrome.tabs.query({ groupId });
      if (tabs.length) await chrome.tabs.ungroup(tabs.map((tab) => tab.id));
    } catch (error) {
      console.warn('[TabStash] Could not ungroup deleted group', groupId, error);
    }
  }
}

/** Close every tab in a saved, live collection. */
export async function closeCollectionTabs(collection) {
  if (!collection?.link?.groupId) return false;
  try {
    const tabs = await chrome.tabs.query({ groupId: collection.link.groupId });
    if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id));
    return true;
  } catch {
    return false;
  }
}

export async function openSingleUrl(url) {
  if (!url) return null;
  try {
    return await chrome.tabs.create({ url, active: true });
  } catch {
    return null;
  }
}
