const SERVER_URL = 'http://127.0.0.1:3197';
const RESERVED_PATHS = new Set([
  'home',
  'explore',
  'notifications',
  'messages',
  'i',
  'search',
  'settings',
  'compose',
  'jobs',
  'login',
  'logout',
  'signup'
]);
const ARTICLE_SELECTORS = [
  'article[data-testid="tweet"]',
  'article[role="article"]',
  '[data-testid="cellInnerDiv"] article',
  'main article'
];
const PASS_SETTINGS = {
  maxSteps: 28,
  pauseMs: 1300,
  idleLimit: 5
};

let enabled = true;
let lastUrl = location.href;
let currentProfile = null;
let scanTimer = null;
let timelinePass = {
  running: false,
  stop: false
};
const seenItems = new Map();

chrome.storage.local.get({ enabled: true }, (state) => {
  enabled = Boolean(state.enabled);
  scheduleScan('startup');
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) {
    enabled = Boolean(changes.enabled.newValue);
    scheduleScan('toggle');
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'captureNow') {
    scanPage({ force: true, reason: 'manual' })
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'startTimelinePass') {
    startTimelinePass();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'stopTimelinePass') {
    timelinePass.stop = true;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    currentProfile = null;
    seenItems.clear();
  }
  scheduleScan('mutation');
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true
});

window.addEventListener('load', () => scheduleScan('load'));
for (const delay of [800, 1800, 3500, 6500]) {
  window.setTimeout(() => scheduleScan(`startup-${delay}`), delay);
}
scheduleScan('initial');

function scheduleScan(reason) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanPage({ reason }).catch((error) => {
      updateCaptureStatus({
        enabled,
        url: location.href,
        reason,
        serverOk: false,
        serverError: error.message
      });
    });
  }, 700);
}

async function scanPage(options = {}) {
  const status = {
    enabled,
    url: location.href,
    reason: options.reason || 'scan',
    profileHandle: null,
    articleCount: 0,
    parsedCount: 0,
    sentCount: 0,
    storedCount: 0,
    visibleKnownItems: seenItems.size,
    sampleText: null,
    serverOk: null,
    serverError: null,
    passRunning: timelinePass.running
  };

  if (!enabled) {
    updateCaptureStatus(status);
    return status;
  }

  const profile = getProfileFromLocation();
  if (!profile) {
    currentProfile = null;
    updateCaptureStatus(status);
    return status;
  }

  profile.displayName = getDisplayName() || profile.handle;
  status.profileHandle = profile.handle;

  if (options.force || !currentProfile || currentProfile.handle !== profile.handle) {
    currentProfile = profile;
    await postJson('/api/profile-observation', {
      platform: 'x',
      handle: profile.handle,
      displayName: profile.displayName,
      profileUrl: profile.profileUrl,
      pageUrl: location.href,
      source: 'extension',
      observedAt: new Date().toISOString()
    });
  }

  const articles = getTimelineArticles();
  const collection = collectTimelineItems(profile.handle, articles, Boolean(options.force));
  status.articleCount = articles.length;
  status.parsedCount = collection.parsedCount;
  status.sentCount = collection.items.length;
  status.sampleText = collection.items.find((item) => item.textContent)?.textContent?.slice(0, 180) || null;

  if (!collection.items.length) {
    status.serverOk = true;
    status.visibleKnownItems = seenItems.size;
    updateCaptureStatus(status);
    return status;
  }

  try {
    const response = await postJson('/api/timeline-observations', {
      platform: 'x',
      profileHandle: profile.handle,
      displayName: profile.displayName,
      profileUrl: profile.profileUrl,
      pageUrl: location.href,
      source: 'extension',
      observedAt: new Date().toISOString(),
      items: collection.items
    });
    status.serverOk = true;
    status.storedCount = response?.observedItems ?? collection.items.length;
  } catch (error) {
    status.serverOk = false;
    status.serverError = error.message;
  }

  status.visibleKnownItems = seenItems.size;
  updateCaptureStatus(status);
  return status;
}

function startTimelinePass() {
  if (timelinePass.running) return;

  timelinePass = {
    running: true,
    stop: false
  };

  runTimelinePass().catch((error) => {
    updateCaptureStatus({
      enabled,
      url: location.href,
      reason: 'timeline-pass-error',
      serverOk: false,
      serverError: error.message,
      passRunning: false
    });
  });
}

async function runTimelinePass() {
  let noGrowthSteps = 0;
  let previousSeen = seenItems.size;

  for (let step = 0; step < PASS_SETTINGS.maxSteps && !timelinePass.stop; step += 1) {
    const status = await scanPage({
      force: step === 0,
      reason: `timeline-pass-${step + 1}`
    });
    status.passRunning = true;
    status.passStep = step + 1;
    updateCaptureStatus(status);

    const currentSeen = seenItems.size;
    if (currentSeen <= previousSeen && status.sentCount === 0) {
      noGrowthSteps += 1;
    } else {
      noGrowthSteps = 0;
    }
    previousSeen = currentSeen;

    if (noGrowthSteps >= PASS_SETTINGS.idleLimit) break;
    scrollTimeline();
    await wait(PASS_SETTINGS.pauseMs);
  }

  await scanPage({ force: true, reason: 'timeline-pass-final' });
  timelinePass = {
    running: false,
    stop: false
  };
  const finalStatus = await scanPage({ reason: 'timeline-pass-complete' });
  finalStatus.passRunning = false;
  updateCaptureStatus(finalStatus);
}

function scrollTimeline() {
  window.scrollBy({
    top: Math.max(500, Math.round(window.innerHeight * 0.85)),
    behavior: 'smooth'
  });
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getProfileFromLocation() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;

  const handle = parts[0];
  if (RESERVED_PATHS.has(handle.toLowerCase())) return null;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (parts[1] && !['with_replies', 'media', 'highlights'].includes(parts[1])) return null;

  return {
    handle,
    profileUrl: `${location.origin}/${handle}`
  };
}

function getDisplayName() {
  const userName = document.querySelector('[data-testid="UserName"]');
  const heading = userName?.querySelector('span') || document.querySelector('main h2 span, main h1 span');
  return cleanText(heading?.textContent);
}

function getTimelineArticles() {
  const root = document.querySelector('main') || document;
  const nodes = ARTICLE_SELECTORS.flatMap((selector) => [...root.querySelectorAll(selector)]);
  const unique = [...new Set(nodes)];

  return unique.filter((article) => {
    return article.querySelector('time[datetime], [data-testid="tweetText"], a[href*="/status/"]');
  });
}

function collectTimelineItems(profileHandle, articles, force) {
  const batch = [];
  let parsedCount = 0;

  for (const article of articles) {
    const parsed = parseArticle(article, profileHandle);
    if (!parsed) continue;

    parsedCount += 1;
    const signature = itemSignature(parsed);
    if (!force && seenItems.get(parsed.itemKey) === signature) continue;

    seenItems.set(parsed.itemKey, signature);
    batch.push(parsed);
  }

  return {
    parsedCount,
    items: batch.slice(0, 150)
  };
}

function parseArticle(article, profileHandle) {
  const time = article.querySelector('time[datetime]');
  const statusUrl = findStatusUrl(article);
  const statusId = statusUrl?.pathname.match(/\/status\/([^/?#]+)/)?.[1] || null;
  const authoredAt = nullableIso(time?.dateTime);
  const textContent = readTweetText(article);
  const authorHandle = getAuthorHandle(article, statusUrl) || profileHandle;

  if (!statusId && !authoredAt && !textContent) return null;

  const itemKey = statusId || `local-${hashString(`${authorHandle}|${authoredAt || ''}|${textContent || ''}`)}`;
  const authorLower = authorHandle.toLowerCase();
  const profileLower = profileHandle.toLowerCase();

  return {
    itemKey,
    statusId,
    itemUrl: statusUrl?.href || null,
    authorHandle,
    authoredAt,
    kind: inferKind(article, authorLower === profileLower),
    textContent,
    replyCount: readMetric(article, 'reply'),
    repostCount: readMetric(article, 'retweet') ?? readMetric(article, 'repost'),
    likeCount: readMetric(article, 'like') ?? readMetric(article, 'unlike'),
    quoteCount: readMetricByLabel(article, /quote/i),
    viewCount: readMetric(article, 'analytics'),
    bookmarkCount: readMetric(article, 'bookmark')
  };
}

function findStatusUrl(article) {
  const timeLink = article.querySelector('time[datetime]')?.closest('a[href*="/status/"]');
  const candidates = [
    timeLink,
    ...article.querySelectorAll('a[href*="/status/"]')
  ].filter(Boolean);

  for (const candidate of candidates) {
    const url = canonicalStatusUrl(candidate.href);
    if (url) return url;
  }

  return null;
}

function canonicalStatusUrl(href) {
  try {
    const url = new URL(href, location.origin);
    const match = url.pathname.match(/^\/([^/]+)\/status\/([^/?#]+)/);
    if (!match) return null;
    return new URL(`/${match[1]}/status/${match[2]}`, url.origin);
  } catch {
    return null;
  }
}

function getAuthorHandle(article, statusUrl) {
  const fromUrl = statusUrl?.pathname.split('/').filter(Boolean)[0];
  if (/^[A-Za-z0-9_]{1,15}$/.test(fromUrl || '')) return fromUrl;

  const handleText = [...article.querySelectorAll('a[href^="/"], a[href^="https://x.com/"], a[href^="https://twitter.com/"]')]
    .map((link) => cleanText(link.textContent))
    .find((text) => /^@[A-Za-z0-9_]{1,15}$/.test(text || ''));

  return handleText ? handleText.slice(1) : null;
}

function readTweetText(article) {
  const textNodes = [...article.querySelectorAll('[data-testid="tweetText"]')];
  const chunks = uniqueStrings(textNodes
    .map((node) => cleanMultiline(node.innerText || node.textContent))
    .filter(Boolean));

  if (chunks.length) return chunks.join('\n\n');

  const fallback = cleanArticleText(article.innerText || article.textContent);
  return fallback || null;
}

function cleanArticleText(text) {
  const ignored = [
    /^@?[A-Za-z0-9_]{1,15}$/,
    /^Follow$/i,
    /^Following$/i,
    /^Subscribe$/i,
    /^Show this thread$/i,
    /^Show more$/i,
    /^Translate post$/i,
    /^Replying to /i,
    /^关注$/,
    /^正在关注$/,
    /^显示更多$/,
    /^翻译帖子$/,
    /^回复给/,
    /^[\d,.]+[KMB万千亿]?\s*(reply|replies|repost|reposts|like|likes|view|views|bookmark|bookmarks)?$/i
  ];

  return cleanMultiline(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !ignored.some((pattern) => pattern.test(line)))
    .join('\n')
    .slice(0, 8000)
    .trim();
}

function inferKind(article, isByProfile) {
  if (!isByProfile) return 'shared';

  const text = cleanText(article.textContent) || '';
  if (/replying to|回复给|正在回复/i.test(text)) return 'reply';
  return 'status';
}

function readMetric(article, testIdPart) {
  const button = article.querySelector(`[data-testid*="${testIdPart}" i]`);
  if (!button) return null;
  return parseMetric(button.getAttribute('aria-label') || button.textContent);
}

function readMetricByLabel(article, pattern) {
  const node = [...article.querySelectorAll('[aria-label]')].find((candidate) => {
    return pattern.test(candidate.getAttribute('aria-label') || '');
  });
  return node ? parseMetric(node.getAttribute('aria-label')) : null;
}

function parseMetric(raw) {
  const text = cleanText(raw);
  if (!text) return null;

  const compact = text.match(/([\d,.]+)\s*([KMB万千亿]?)/i);
  if (!compact) return text === '' ? 0 : null;

  const base = Number(compact[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;

  const unit = compact[2]?.toLowerCase();
  const multiplier = {
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
    千: 1_000,
    万: 10_000,
    亿: 100_000_000
  }[unit] || 1;

  return Math.round(base * multiplier);
}

async function postJson(path, body) {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${response.status} ${detail || response.statusText}`);
  }

  return response.json().catch(() => ({}));
}

function updateCaptureStatus(status) {
  chrome.storage.local.set({
    lastCapture: {
      updatedAt: new Date().toISOString(),
      ...status
    }
  });
}

function itemSignature(item) {
  return JSON.stringify({
    textContent: item.textContent || '',
    replyCount: item.replyCount,
    repostCount: item.repostCount,
    likeCount: item.likeCount,
    quoteCount: item.quoteCount,
    viewCount: item.viewCount,
    bookmarkCount: item.bookmarkCount
  });
}

function nullableIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanMultiline(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
