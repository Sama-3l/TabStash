/**
 * TabStash shared data layer.
 * Used by the service worker, dashboard and popup.
 */

export const STORAGE = {
  groups: 'ts_groups',
  settings: 'ts_settings',
  ignored: 'ts_ignored_groups',
  meta: 'ts_meta',
};

export const DEFAULT_SETTINGS = {
  autoSave: true,
  skipExisting: true,
  confirmDelete: true,
  trackIncognito: false,
  theme: 'auto',
};

export const TAB_GROUP_COLORS = [
  { name: 'grey', hex: '#5f6368' },
  { name: 'blue', hex: '#1a73e8' },
  { name: 'red', hex: '#d93025' },
  { name: 'yellow', hex: '#f9ab00' },
  { name: 'green', hex: '#188038' },
  { name: 'pink', hex: '#d01884' },
  { name: 'purple', hex: '#9334e6' },
  { name: 'cyan', hex: '#007b83' },
  { name: 'orange', hex: '#fa903e' },
];

export const COLOR_HEX = Object.fromEntries(TAB_GROUP_COLORS.map((c) => [c.name, c.hex]));
export const COLOR_NAMES = TAB_GROUP_COLORS.map((c) => c.name);

export function uid(prefix = 'g') {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export function now() {
  return Date.now();
}

export function validColor(color) {
  return COLOR_NAMES.includes(color) ? color : 'blue';
}

export function colorHex(color) {
  return COLOR_HEX[validColor(color)];
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export async function getGroups() {
  const data = await chrome.storage.local.get(STORAGE.groups);
  const raw = data[STORAGE.groups];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isGroupShape).map(sanitizeGroup);
}

export async function setGroups(groups) {
  await chrome.storage.local.set({ [STORAGE.groups]: groups.map(sanitizeGroup) });
}

/** Serialize read-modify-write operations across extension contexts. */
export async function withStoreLock(task) {
  const locks = globalThis.navigator?.locks;
  if (locks && typeof locks.request === 'function') {
    return locks.request('tabstash:store', task);
  }
  return task();
}

/** Read-modify-write helper. The mutator may return a new array or mutate in place. */
export async function updateGroups(mutator) {
  return withStoreLock(async () => {
    const groups = await getGroups();
    const next = (await mutator(groups)) || groups;
    await setGroups(next);
    return next;
  });
}

export async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE.settings);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE.settings] || {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE.settings]: next });
  return next;
}

export async function getIgnored() {
  const data = await chrome.storage.local.get(STORAGE.ignored);
  const raw = data[STORAGE.ignored];
  return Array.isArray(raw) ? raw.map(Number).filter(Number.isFinite) : [];
}

export async function setIgnored(ids) {
  await chrome.storage.local.set({ [STORAGE.ignored]: [...new Set(ids.map(Number))] });
}

export async function addIgnored(id) {
  if (typeof id !== 'number') return;
  const ids = await getIgnored();
  if (!ids.includes(id)) await setIgnored([...ids, id]);
}

export async function removeIgnored(id) {
  const ids = await getIgnored();
  if (ids.includes(id)) await setIgnored(ids.filter((x) => x !== id));
}

export async function getMeta() {
  const data = await chrome.storage.local.get(STORAGE.meta);
  return data[STORAGE.meta] || {};
}

export async function setMeta(patch) {
  const meta = await getMeta();
  await chrome.storage.local.set({ [STORAGE.meta]: { ...meta, ...patch } });
}

/** Subscribe to changes to the saved-groups array. */
export function onGroupsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[STORAGE.groups]) {
      callback(changes[STORAGE.groups].newValue || []);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

function isGroupShape(value) {
  return Boolean(value && typeof value === 'object' && typeof value.id === 'string');
}

function sanitizeGroup(group) {
  return {
    id: group.id,
    name: String(group.name || 'Untitled group').slice(0, 160),
    color: validColor(group.color),
    tabs: Array.isArray(group.tabs) ? group.tabs.map(sanitizeTab).filter(Boolean) : [],
    note: typeof group.note === 'string' ? group.note.slice(0, 2000) : '',
    createdAt: Number(group.createdAt) || now(),
    updatedAt: Number(group.updatedAt) || Number(group.createdAt) || now(),
    closedAt: group.closedAt ? Number(group.closedAt) : null,
    source: group.source === 'auto' ? 'auto' : 'manual',
    link:
      group.link && typeof group.link.groupId === 'number'
        ? { groupId: group.link.groupId, windowId: Number(group.link.windowId) || null }
        : null,
  };
}

function sanitizeTab(tab) {
  if (!tab || typeof tab.url !== 'string' || !tab.url) return null;
  return {
    url: tab.url.slice(0, 20000),
    title: String(tab.title || tab.url).slice(0, 1000),
    pinned: Boolean(tab.pinned),
    favIconUrl: typeof tab.favIconUrl === 'string' ? tab.favIconUrl : '',
  };
}

export function tabFromChrome(tab) {
  const url = tab.url || tab.pendingUrl || '';
  if (!url || url === 'chrome://newtab/') return null;
  return {
    url,
    title: tab.title || url,
    pinned: Boolean(tab.pinned),
    favIconUrl: tab.favIconUrl || '',
  };
}

export function createCollection({ name, color = 'blue', tabs = [], source = 'manual', link = null, note = '' }) {
  const ts = now();
  return sanitizeGroup({
    id: uid('g'),
    name: name || 'Untitled group',
    color,
    tabs,
    source,
    link,
    note,
    createdAt: ts,
    updatedAt: ts,
  });
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function prettyUrl(url) {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`.replace(/\/$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path === '/' ? '' : path}`;
  } catch {
    return url;
  }
}

/** URL key used for duplicate detection. Fragments are ignored. */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/+$/, '');
    return u.href;
  } catch {
    return String(url || '');
  }
}

export function dedupeTabs(tabs) {
  const seen = new Set();
  const out = [];
  for (const tab of tabs) {
    const key = normalizeUrl(tab.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(tab);
  }
  return out;
}

export function sameTabSet(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].url !== b[i].url) return false;
    if (a[i].title !== b[i].title) return false;
    if (a[i].pinned !== b[i].pinned) return false;
  }
  return true;
}

export function groupSignature(group, tabs) {
  return [
    group.title || '',
    group.color || '',
    tabs.map((t) => `${t.url}\u0000${t.title}\u0000${t.pinned ? 1 : 0}`).join('\u0001'),
  ].join('\u0002');
}

export function topDomains(tabs, limit = 3) {
  const counts = new Map();
  for (const tab of tabs) {
    const host = hostOf(tab.url);
    if (!host) continue;
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    top: sorted.slice(0, limit),
    extra: Math.max(0, sorted.length - limit),
    total: counts.size,
  };
}

export function faviconSrc(url, fallback = '', size = 32) {
  if (!url) return fallback;
  try {
    if (chrome?.runtime?.getURL) {
      return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=${size}`;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

export function prettyDomain(url) {
  return hostOf(url) || 'page';
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function formatRelative(ts) {
  if (!ts) return '—';
  const diff = Date.now() - Number(ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDay(date = new Date()) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** New groups are named "<name> · <date>"; the date is fixed by TabStash. */
export function datedGroupName(base, date = new Date()) {
  const cleaned = String(base ?? '').trim();
  return `${cleaned || 'Untitled group'} · ${formatDay(date)}`;
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function slugify(value) {
  return (
    String(value || 'tabstash')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'tabstash'
  );
}
