/* Mock Chrome APIs for previewing the TabStash dashboard in a normal browser. */

const listeners = new Set();
const tabGroupsListeners = { created: [], updated: [], removed: [] };
const tabListeners = { created: [], removed: [], updated: [], moved: [], attached: [], detached: [] };
const windowListeners = { removed: [] };

const sampleTabs = [
  // Design research — live group 101
  ['Figma · Mobile explorations', 'https://www.figma.com/file/design-explorations', 101, 1, 'blue'],
  ['Dribbble — dashboard shots', 'https://dribbble.com/shots/popular/web-design', 101, 1, 'blue'],
  ['Mobbin — SaaS patterns', 'https://mobbin.com/browse/ios/apps', 101, 1, 'blue'],
  ['Google Fonts — pairing ideas', 'https://fonts.google.com/', 101, 1, 'blue'],
  ['Coolors — palette generator', 'https://coolors.co/palettes/trending', 101, 1, 'blue'],
  ['Are.na — visual research', 'https://www.are.na/', 101, 1, 'blue'],
  ['Refactoring UI', 'https://www.refactoringui.com/', 101, 1, 'blue'],

  // Weekly planning — live group 102
  ['Calendar · This week', 'https://calendar.google.com/calendar/u/0/r/week', 102, 1, 'green'],
  ['Todoist · Inbox', 'https://todoist.com/app/today', 102, 1, 'green'],
  ['Google Keep — notes', 'https://keep.google.com/', 102, 1, 'green'],
  ['Notion — weekly review', 'https://www.notion.so/weekly-review-template', 102, 1, 'green'],

  // Q4 planning — live group 103 (auto-saved)
  ['Q4 planning doc', 'https://docs.google.com/document/d/q4-planning', 103, 1, 'purple'],
  ['Miro — roadmap board', 'https://miro.com/app/board/roadmap-q4', 103, 1, 'purple'],
  ['Linear — Q4 cycle', 'https://linear.app/team/cycle/q4', 103, 1, 'purple'],
  ['Notion — team goals', 'https://www.notion.so/team-goals-q4', 103, 1, 'purple'],
  ['Figma — Q4 roadmap', 'https://www.figma.com/file/q4-roadmap', 103, 1, 'purple'],
  ['Slack — #product', 'https://app.slack.com/client/T123/C456', 103, 1, 'purple'],

  // Ungrouped — this window
  ['GitHub · Notifications', 'https://github.com/notifications', -1, 1, null],
  ['Hacker News', 'https://news.ycombinator.com/', -1, 1, null],
  ['X — Following', 'https://x.com/home', -1, 1, null],
  ['YouTube — Frontend Conf 2026', 'https://www.youtube.com/watch?v=frontend-conf', -1, 1, null],
  ['localhost:3000', 'http://localhost:3000/', -1, 1, null],

  // Window 2
  ['Stripe · Dashboard', 'https://dashboard.stripe.com/test/dashboard', -1, 2, null],
  ['Vercel · Deployments', 'https://vercel.com/tabstash/deployments', -1, 2, null],
  ['Sentry · Issues', 'https://tabstash.sentry.io/issues/', -1, 2, null],
  ['PostHog · Insights', 'https://us.posthog.com/project/insights', -1, 2, null],
  ['Figma · Component library', 'https://www.figma.com/file/component-library', -1, 2, null],
  ['Linear · Backlog', 'https://linear.app/team/backlog', -1, 2, null],
];

const tabGroups = new Map([
  [101, { id: 101, windowId: 1, title: 'Design research', color: 'blue', collapsed: false }],
  [102, { id: 102, windowId: 1, title: 'Weekly planning', color: 'green', collapsed: false }],
  [103, { id: 103, windowId: 1, title: 'Q4 planning', color: 'purple', collapsed: false }],
]);

const windows = [
  { id: 1, incognito: false, focused: true, state: 'normal' },
  { id: 2, incognito: false, focused: false, state: 'normal' },
];

const tabs = sampleTabs.map(([title, url, groupId, windowId], index) => ({
  id: 1000 + index,
  index: index,
  windowId,
  groupId,
  title,
  url,
  favIconUrl: '',
  pinned: index === 18,
  active: index === 15,
  lastAccessed: Date.now() - index * 1000 * 60 * 7,
}));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function groupTabs(groupId) {
  return tabs
    .filter((tab) => tab.groupId === groupId)
    .sort((a, b) => a.index - b.index)
    .map((tab) => ({
      url: tab.url,
      title: tab.title,
      pinned: tab.pinned,
      favIconUrl: '',
    }));
}

const savedGroups = [
  {
    id: 'g_design_research',
    name: 'Design research',
    color: 'blue',
    tabs: groupTabs(101),
    source: 'auto',
    createdAt: Date.now() - 9 * DAY,
    updatedAt: Date.now() - 3 * MIN,
    link: { groupId: 101, windowId: 1 },
  },
  {
    id: 'g_weekly_planning',
    name: 'Weekly planning',
    color: 'green',
    tabs: groupTabs(102),
    source: 'auto',
    createdAt: Date.now() - 20 * DAY,
    updatedAt: Date.now() - 22 * MIN,
    link: { groupId: 102, windowId: 1 },
  },
  {
    id: 'g_q4_planning',
    name: 'Q4 planning',
    color: 'purple',
    tabs: groupTabs(103),
    source: 'auto',
    createdAt: Date.now() - 2 * DAY,
    updatedAt: Date.now() - 51 * MIN,
    link: { groupId: 103, windowId: 1 },
  },
  {
    id: 'g_launch_checklist',
    name: 'Launch checklist',
    color: 'red',
    tabs: [
      { url: 'https://linear.app/team/project/launch', title: 'Linear · Launch project', pinned: false },
      { url: 'https://www.notion.so/launch-checklist', title: 'Notion · Launch checklist', pinned: false },
      { url: 'https://github.com/tabstash/web/pulls', title: 'Pull requests · tabstash/web', pinned: false },
      { url: 'https://vercel.com/tabstash/web', title: 'Vercel · Production', pinned: false },
      { url: 'https://tabstash.sentry.io/releases/', title: 'Sentry · Releases', pinned: false },
      { url: 'https://www.loom.com/share/launch-demo', title: 'Loom · Launch demo walkthrough', pinned: false },
      { url: 'https://app.slack.com/client/T123/C789', title: 'Slack · #launch-room', pinned: false },
      { url: 'https://docs.google.com/document/d/press-kit', title: 'Press kit draft', pinned: false },
      { url: 'https://miro.com/app/board/launch-retro', title: 'Miro · Launch retro', pinned: false },
    ],
    source: 'manual',
    createdAt: Date.now() - 5 * DAY,
    updatedAt: Date.now() - 2 * HOUR,
    link: null,
  },
  {
    id: 'g_react_docs',
    name: 'React & Next.js docs',
    color: 'cyan',
    tabs: [
      { url: 'https://react.dev/learn', title: 'Learn React', pinned: false },
      { url: 'https://react.dev/reference/react', title: 'React API reference', pinned: false },
      { url: 'https://nextjs.org/docs/app', title: 'Next.js App Router docs', pinned: false },
      { url: 'https://tanstack.com/query/latest', title: 'TanStack Query', pinned: false },
      { url: 'https://www.typescriptlang.org/docs/', title: 'TypeScript documentation', pinned: false },
      { url: 'https://developer.mozilla.org/en-US/docs/Web/API', title: 'MDN Web APIs', pinned: false },
      { url: 'https://web.dev/articles', title: 'web.dev articles', pinned: false },
      { url: 'https://ui.shadcn.com/docs', title: 'shadcn/ui docs', pinned: false },
      { url: 'https://tailwindcss.com/docs', title: 'Tailwind CSS docs', pinned: false },
      { url: 'https://zod.dev/', title: 'Zod documentation', pinned: false },
      { url: 'https://vite.dev/guide/', title: 'Vite guide', pinned: false },
      { url: 'https://esbuild.github.io/api/', title: 'esbuild API', pinned: false },
    ],
    source: 'manual',
    createdAt: Date.now() - 1 * DAY,
    updatedAt: Date.now() - 1 * DAY,
    link: null,
  },
  {
    id: 'g_ai_reading',
    name: 'AI reading list',
    color: 'pink',
    tabs: [
      { url: 'https://openai.com/research', title: 'OpenAI research', pinned: false },
      { url: 'https://www.anthropic.com/research', title: 'Anthropic research', pinned: false },
      { url: 'https://deepmind.google/research/', title: 'Google DeepMind research', pinned: false },
      { url: 'https://huggingface.co/papers', title: 'Hugging Face papers', pinned: false },
      { url: 'https://arxiv.org/list/cs.CL/recent', title: 'arXiv · Computation and Language', pinned: false },
      { url: 'https://www.latent.space/', title: 'Latent Space', pinned: false },
      { url: 'https://simonwillison.net/', title: 'Simon Willison’s Weblog', pinned: false },
    ],
    source: 'manual',
    createdAt: Date.now() - 3 * DAY,
    updatedAt: Date.now() - 3 * HOUR,
    link: null,
  },
  {
    id: 'g_groceries',
    name: 'Groceries & recipes',
    color: 'orange',
    tabs: [
      { url: 'https://www.seriouseats.com/', title: 'Serious Eats', pinned: false },
      { url: 'https://cooking.nytimes.com/', title: 'NYT Cooking', pinned: false },
      { url: 'https://www.kingarthurbaking.com/recipes', title: 'King Arthur Baking recipes', pinned: false },
      { url: 'https://www.instacart.com/', title: 'Instacart', pinned: false },
      { url: 'https://www.bonappetit.com/', title: 'Bon Appétit', pinned: false },
    ],
    source: 'manual',
    createdAt: Date.now() - 14 * DAY,
    updatedAt: Date.now() - 2 * DAY,
    link: null,
  },
  {
    id: 'g_travel_japan',
    name: 'Travel — Japan',
    color: 'yellow',
    tabs: [
      { url: 'https://www.japan-guide.com/', title: 'Japan Guide', pinned: false },
      { url: 'https://www.google.com/travel/explore', title: 'Google Travel · Japan', pinned: false },
      { url: 'https://www.airbnb.com/s/Tokyo', title: 'Airbnb · Tokyo stays', pinned: false },
      { url: 'https://www.booking.com/country/jp.html', title: 'Booking.com · Japan', pinned: false },
      { url: 'https://www.jreast.co.jp/e/', title: 'JR East', pinned: false },
      { url: 'https://www.tabelog.com/en/', title: 'Tabelog', pinned: false },
      { url: 'https://www.teamlab.art/', title: 'teamLab Planets', pinned: false },
      { url: 'https://www.ghibli-museum.jp/en/', title: 'Ghibli Museum', pinned: false },
    ],
    source: 'manual',
    createdAt: Date.now() - 30 * DAY,
    updatedAt: Date.now() - 4 * DAY,
    link: null,
  },
  {
    id: 'g_zero_inbox',
    name: 'Inbox zero systems',
    color: 'grey',
    tabs: [
      { url: 'https://mail.google.com/', title: 'Gmail', pinned: false },
      { url: 'https://superhuman.com/', title: 'Superhuman', pinned: false },
      { url: 'https://www.notion.so/inbox-zero', title: 'Notion · Inbox zero system', pinned: false },
    ],
    source: 'manual',
    createdAt: Date.now() - 40 * DAY,
    updatedAt: Date.now() - 9 * DAY,
    link: null,
  },
];

const forcedTheme = new URLSearchParams(location.search).get('theme');

const store = {
  ts_groups: savedGroups,
  ts_settings: {
    autoSave: true,
    skipExisting: true,
    confirmDelete: true,
    trackIncognito: false,
    theme: forcedTheme === 'light' || forcedTheme === 'dark' ? forcedTheme : 'auto',
  },
  ts_ignored_groups: [],
  ts_meta: { lastSyncAt: Date.now() },
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function notify(changes) {
  listeners.forEach((callback) => callback(changes, 'local'));
}

async function storageGet(keys) {
  if (keys == null) return clone(store);
  if (typeof keys === 'string') {
    if (keys in store) return { [keys]: clone(store[keys]) };
    return {};
  }
  if (Array.isArray(keys)) {
    const out = {};
    for (const key of keys) if (key in store) out[key] = clone(store[key]);
    return out;
  }
  const out = { ...keys };
  for (const key of Object.keys(keys)) {
    if (key in store) out[key] = clone(store[key]);
  }
  return out;
}

async function storageSet(values) {
  const changes = {};
  for (const [key, value] of Object.entries(values)) {
    changes[key] = { oldValue: clone(store[key]), newValue: clone(value) };
    store[key] = clone(value);
  }
  notify(changes);
}

function createTab({ url = 'about:blank', windowId = 1, active = false, pinned = false }) {
  const windowTabs = tabs.filter((tab) => tab.windowId === windowId);
  const tab = {
    id: Math.max(...tabs.map((item) => item.id), 1000) + 1,
    index: windowTabs.length,
    windowId,
    groupId: -1,
    title: url,
    url,
    pinned,
    active,
    lastAccessed: Date.now(),
  };
  tabs.push(tab);
  return clone(tab);
}

let nextGroupId = 201;

const chrome = {
  runtime: {
    id: 'mockextensionid',
    getURL(path = '') {
      if (path.startsWith('/_favicon/')) return '/mock-favicon.svg';
      return path.startsWith('/') ? path : `/${path}`;
    },
    async sendMessage(message) {
      if (message?.type === 'tabstash:sync') {
        await new Promise((resolve) => setTimeout(resolve, 140));
        return { ok: true, lastSyncAt: Date.now() };
      }
      return { ok: true };
    },
    onMessage: { addListener() {} },
  },
  extension: {
    async isAllowedIncognitoAccess() {
      return false;
    },
  },
  storage: {
    local: { get: storageGet, set: storageSet, remove: async () => {} },
    onChanged: {
      addListener(callback) {
        listeners.add(callback);
      },
      removeListener(callback) {
        listeners.delete(callback);
      },
    },
  },
  tabs: {
    async query(query = {}) {
      let result = tabs;
      if (query.windowId != null) result = result.filter((tab) => tab.windowId === query.windowId);
      if (query.groupId != null) result = result.filter((tab) => tab.groupId === query.groupId);
      return clone(result);
    },
    async create(options) {
      return createTab(options);
    },
    async update(tabId, patch) {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) throw new Error('No tab');
      Object.assign(tab, patch);
      tab.lastAccessed = Date.now();
      return clone(tab);
    },
    async remove(tabIds) {
      const ids = new Set(Array.isArray(tabIds) ? tabIds : [tabIds]);
      for (let i = tabs.length - 1; i >= 0; i -= 1) if (ids.has(tabs[i].id)) tabs.splice(i, 1);
    },
    async group({ tabIds, createProperties }) {
      const groupId = nextGroupId++;
      tabGroups.set(groupId, {
        id: groupId,
        windowId: createProperties?.windowId ?? 1,
        title: '',
        color: 'blue',
        collapsed: false,
      });
      for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = groupId;
      return groupId;
    },
    async ungroup(tabIds) {
      for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = -1;
      // Chrome drops a tab group once its last tab leaves it.
      for (const [groupId] of tabGroups) {
        if (!tabs.some((tab) => tab.groupId === groupId)) tabGroups.delete(groupId);
      }
    },
    async move(tabIds, { windowId, index }) {
      const ids = new Set(Array.isArray(tabIds) ? tabIds : [tabIds]);
      let cursor = index;
      for (const tab of tabs) {
        if (!ids.has(tab.id)) continue;
        tab.windowId = windowId;
        if (cursor >= 0) tab.index = cursor++;
      }
      return clone(tabs.filter((tab) => ids.has(tab.id)));
    },
    onCreated: { addListener() {} },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    onMoved: { addListener() {} },
    onAttached: { addListener() {} },
    onDetached: { addListener() {} },
  },
  tabGroups: {
    TAB_GROUP_ID_NONE: -1,
    async query() {
      return clone([...tabGroups.values()]);
    },
    async get(groupId) {
      const group = tabGroups.get(groupId);
      if (!group) throw new Error('No group');
      return clone(group);
    },
    async update(groupId, patch) {
      const group = tabGroups.get(groupId);
      if (!group) throw new Error('No group');
      Object.assign(group, patch);
      return clone(group);
    },
    onCreated: { addListener() {} },
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
  },
  windows: {
    async getAll() {
      return clone(windows);
    },
    async getCurrent() {
      return clone(windows[0]);
    },
    async get(windowId) {
      return clone(windows.find((win) => win.id === windowId) || windows[0]);
    },
    async update(windowId, patch) {
      const win = windows.find((item) => item.id === windowId);
      if (win) Object.assign(win, patch);
      return clone(win || windows[0]);
    },
    async create({ url, incognito = false }) {
      const id = Math.max(...windows.map((win) => win.id)) + 1;
      const win = { id, incognito, focused: true, state: 'normal' };
      windows.push(win);
      const tab = createTab({ url, windowId: id, active: true });
      return { ...clone(win), tabs: [tab] };
    },
    onRemoved: { addListener() {} },
  },
};

window.chrome = chrome;
window.__tabstashPreview = true;
