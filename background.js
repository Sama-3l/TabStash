/**
 * TabStash service worker.
 * Keeps a live, persistent mirror of every Chrome tab group in the library.
 */

import {
  createCollection,
  getGroups,
  getIgnored,
  getSettings,
  groupSignature,
  setGroups,
  setIgnored,
  setMeta,
  tabFromChrome,
  withStoreLock,
} from './shared/store.js';

const GROUP_NONE = chrome.tabGroups.TAB_GROUP_ID_NONE ?? -1;
const SYNC_DELAY = 500;

let syncTimer = null;
let syncing = false;
let syncAgain = false;
let lastSyncAt = 0;

function scheduleSync(delay = SYNC_DELAY) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    runSync();
  }, delay);
}

async function runSync() {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    await syncLiveGroups();
    lastSyncAt = Date.now();
    await setMeta({ lastSyncAt });
  } catch (error) {
    console.error('[TabStash] Sync failed:', error);
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      scheduleSync(250);
    }
  }
}

async function syncLiveGroups() {
  return withStoreLock(syncLiveGroupsLocked);
}

async function syncLiveGroupsLocked() {
  const [settings, groups, ignored, chromeGroups, chromeTabs, windows] = await Promise.all([
    getSettings(),
    getGroups(),
    getIgnored(),
    chrome.tabGroups.query({}),
    chrome.tabs.query({}),
    chrome.windows.getAll({ populate: false }),
  ]);

  if (!groups.length && !chromeGroups.length && settings.autoSave === false) return;

  const ignoredSet = new Set(ignored);
  const incognitoWindowIds = new Set(windows.filter((w) => w.incognito).map((w) => w.id));
  const trackedWindowIds = new Set(
    windows.filter((w) => settings.trackIncognito || !w.incognito).map((w) => w.id),
  );

  const tabsByGroup = new Map();
  for (const tab of chromeTabs) {
    if (tab.groupId === GROUP_NONE) continue;
    if (!trackedWindowIds.has(tab.windowId)) continue;
    if (!tabsByGroup.has(tab.groupId)) tabsByGroup.set(tab.groupId, []);
    tabsByGroup.get(tab.groupId).push(tab);
  }

  const syncableGroups = chromeGroups.filter((g) => trackedWindowIds.has(g.windowId));
  const allGroupIds = new Set(chromeGroups.map((g) => g.id));
  const linkedByGroupId = new Map();
  for (const group of groups) {
    if (group.link) linkedByGroupId.set(group.link.groupId, group);
  }

  let changed = false;
  const ts = Date.now();
  const newCollections = [];

  for (const chromeGroup of syncableGroups) {
    const groupTabs = (tabsByGroup.get(chromeGroup.id) || [])
      .slice()
      .sort((a, b) => a.index - b.index)
      .map(tabFromChrome)
      .filter(Boolean);

    const linked = linkedByGroupId.get(chromeGroup.id);
    if (linked) {
      const liveName = chromeGroup.title || 'Untitled group';
      const liveSignature = groupSignature(
        { title: liveName, color: chromeGroup.color },
        groupTabs,
      );
      const savedSignature = groupSignature(
        { title: linked.name, color: linked.color },
        linked.tabs,
      );
      const windowChanged = linked.link?.windowId !== chromeGroup.windowId;
      if (liveSignature !== savedSignature || windowChanged) {
        linked.name = liveName;
        linked.color = chromeGroup.color || linked.color;
        linked.tabs = groupTabs;
        linked.link = { groupId: chromeGroup.id, windowId: chromeGroup.windowId };
        linked.closedAt = null;
        linked.updatedAt = ts;
        changed = true;
      } else if (linked.closedAt) {
        linked.closedAt = null;
        changed = true;
      }
    } else if (settings.autoSave && !ignoredSet.has(chromeGroup.id)) {
      newCollections.push(
        createCollection({
          name: chromeGroup.title || 'Untitled group',
          color: chromeGroup.color,
          tabs: groupTabs,
          source: 'auto',
          link: { groupId: chromeGroup.id, windowId: chromeGroup.windowId },
        }),
      );
      changed = true;
    }
  }

  if (newCollections.length) {
    groups.unshift(...newCollections);
  }

  for (const group of groups) {
    if (!group.link) continue;
    if (!allGroupIds.has(group.link.groupId)) {
      group.link = null;
      group.closedAt = group.closedAt || ts;
      changed = true;
    }
  }

  if (changed) {
    await setGroups(groups);
  }

  // Forget ignore markers for groups that no longer exist.
  const prunedIgnored = ignored.filter((id) => allGroupIds.has(id));
  if (prunedIgnored.length !== ignored.length) {
    await setIgnored(prunedIgnored);
  }
}

async function openDashboard() {
  const url = chrome.runtime.getURL('dashboard/dashboard.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => (tab.url || '').startsWith(url));
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existing.id, { active: true });
    return;
  }
  await chrome.tabs.create({ url });
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => scheduleSync(300));
chrome.runtime.onStartup.addListener(() => scheduleSync(300));

chrome.tabGroups.onCreated.addListener(() => scheduleSync());
chrome.tabGroups.onUpdated.addListener(() => scheduleSync());
chrome.tabGroups.onRemoved.addListener(() => scheduleSync());

chrome.tabs.onCreated.addListener(() => scheduleSync());
chrome.tabs.onRemoved.addListener(() => scheduleSync());
chrome.tabs.onMoved.addListener(() => scheduleSync(900));
chrome.tabs.onAttached.addListener(() => scheduleSync());
chrome.tabs.onDetached.addListener(() => scheduleSync());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.title !== undefined || changeInfo.url !== undefined || changeInfo.pinned !== undefined) {
    scheduleSync(900);
  }
});

chrome.windows.onRemoved.addListener(() => scheduleSync());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.ts_settings || changes.ts_ignored_groups) scheduleSync(250);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'tabstash:sync') {
    runSync()
      .then(() => sendResponse({ ok: true, lastSyncAt: Date.now() }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'tabstash:open-dashboard') {
    openDashboard();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-dashboard') openDashboard();
});

// Initial sync (covers the first load after installation).
scheduleSync(400);
