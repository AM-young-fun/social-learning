const profileList = document.querySelector('#profile-list');
const emptyState = document.querySelector('#empty-state');
const profileView = document.querySelector('#profile-view');
const profileName = document.querySelector('#profile-name');
const profileMeta = document.querySelector('#profile-meta');
const rangeSelect = document.querySelector('#range-select');
const statItems = document.querySelector('#stat-items');
const statVisits = document.querySelector('#stat-visits');
const statMaxDay = document.querySelector('#stat-max-day');
const statHour = document.querySelector('#stat-hour');
const contentSummary = document.querySelector('#content-summary');
const keywordCloud = document.querySelector('#keyword-cloud');
const hourChartEl = document.querySelector('#hour-chart');
const dailyTable = document.querySelector('#daily-table');
const recentItems = document.querySelector('#recent-items');
const STOP_WORDS = new Set([
  'http',
  'https',
  'com',
  'www',
  'the',
  'and',
  'that',
  'this',
  'with',
  'for',
  'from',
  'are',
  'was',
  'will',
  'you',
  'your',
  'have',
  'has',
  'about',
  'just',
  'not',
  'but',
  'all',
  'can',
  'more',
  'new',
  'via',
  '我们',
  '他们',
  '这个',
  '一个',
  '不是',
  '没有',
  '就是',
  '可以',
  '因为',
  '所以',
  '如果',
  '什么',
  '自己',
  '现在',
  '还是',
  '已经',
  '以及',
  '进行',
  '这些',
  '那些'
]);

let profiles = [];
let selectedHandle = null;
let hourChart = null;
let hourChartResizeObserver = null;

rangeSelect.addEventListener('change', () => {
  if (selectedHandle) loadProfile(selectedHandle);
});

window.addEventListener('resize', () => {
  hourChart?.resize();
});

await loadProfiles();
setInterval(loadProfiles, 10_000);

async function loadProfiles() {
  const response = await fetch('/api/profiles');
  const data = await response.json();
  profiles = data.profiles || [];

  if (!selectedHandle && profiles.length) {
    selectedHandle = profiles[0].handle;
  }

  emptyState.classList.toggle('hidden', profiles.length > 0);
  profileView.classList.toggle('hidden', !profiles.length);
  renderProfileList();

  if (selectedHandle && profiles.some((profile) => profile.handle === selectedHandle)) {
    await loadProfile(selectedHandle);
  }
}

function renderProfileList() {
  profileList.innerHTML = '';

  for (const profile of profiles) {
    const button = document.createElement('button');
    button.className = `profile-button${profile.handle === selectedHandle ? ' active' : ''}`;
    button.type = 'button';
    button.innerHTML = `
      <strong>${escapeHtml(profile.display_name || `@${profile.handle}`)}</strong>
      <span>@${escapeHtml(profile.handle)} · ${profile.item_count || 0} items</span>
    `;
    button.addEventListener('click', () => {
      selectedHandle = profile.handle;
      renderProfileList();
      loadProfile(profile.handle);
    });
    profileList.append(button);
  }
}

async function loadProfile(handle) {
  const days = rangeSelect.value;
  const response = await fetch(`/api/profiles/${encodeURIComponent(handle)}?days=${days}`);
  if (!response.ok) return;

  const data = await response.json();
  renderProfile(data);
}

function renderProfile(data) {
  const { profile, totals, daily, recentItems: items } = data;
  const localHourly = buildHourlySeries(items, Number(rangeSelect.value));
  const maxDay = Math.max(0, ...daily.map((row) => Number(row.item_count) || 0));
  const topHour = localHourly.reduce((best, row) => {
    return Number(row.item_count) > Number(best?.item_count || 0) ? row : best;
  }, null);

  profileName.textContent = profile.display_name || `@${profile.handle}`;
  profileMeta.textContent = `@${profile.handle} · 首次观察 ${formatDateTime(profile.first_seen_at)} · 最近观察 ${formatDateTime(profile.last_seen_at)}`;
  statItems.textContent = String(totals?.item_count ?? items.length);
  statVisits.textContent = String(profile.visit_count || 0);
  statMaxDay.textContent = String(maxDay);
  statHour.textContent = topHour && topHour.item_count ? `${String(topHour.hour).padStart(2, '0')}:00` : '-';

  renderContentAnalysis(items);
  renderHours(localHourly);
  renderDaily(daily);
  renderRecent(items);
}

function buildHourlySeries(items, days) {
  const cutoff = Date.now() - Math.min(Math.max(days || 30, 1), 366) * 24 * 60 * 60 * 1000;
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    item_count: 0,
    post_count: 0,
    reply_count: 0,
    like_count: 0
  }));

  for (const item of items) {
    const timestamp = Date.parse(item.authored_at || item.first_seen_at);
    if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;

    const bucket = hours[new Date(timestamp).getHours()];
    const isReply = String(item.kind || '').toLowerCase() === 'reply';
    bucket.item_count += 1;
    bucket.like_count += Number(item.like_count) || 0;

    if (isReply) {
      bucket.reply_count += 1;
    } else {
      bucket.post_count += 1;
    }
  }

  return hours;
}

function renderContentAnalysis(items) {
  const textItems = items.filter((item) => item.text_content);
  const texts = textItems.map((item) => item.text_content);
  const totalChars = texts.reduce((sum, text) => sum + text.length, 0);
  const avgChars = textItems.length ? Math.round(totalChars / textItems.length) : 0;
  const hashtags = topMatches(texts, /#[\p{L}\p{N}_]+/gu, 12);
  const mentions = topMatches(texts, /@[A-Za-z0-9_]{1,15}/g, 8);
  const terms = topTerms(texts, 24);

  contentSummary.innerHTML = `
    <div class="content-chip"><span>有正文</span><strong>${number(textItems.length)}</strong></div>
    <div class="content-chip"><span>平均字数</span><strong>${number(avgChars)}</strong></div>
    <div class="content-chip"><span>Hashtags</span><strong>${number(hashtags.length)}</strong></div>
    <div class="content-chip"><span>Mentions</span><strong>${number(mentions.length)}</strong></div>
  `;

  keywordCloud.innerHTML = '';
  renderKeywordGroup('关键词', terms);
  renderKeywordGroup('Hashtags', hashtags);
  renderKeywordGroup('Mentions', mentions);

  if (!textItems.length) {
    keywordCloud.innerHTML = '<div class="muted-note">还没有抓到帖子正文。</div>';
  }
}

function renderKeywordGroup(label, entries) {
  if (!entries.length) return;

  const group = document.createElement('div');
  group.className = 'keyword-group';
  const title = document.createElement('strong');
  title.textContent = label;
  group.append(title);

  for (const entry of entries) {
    const pill = document.createElement('span');
    pill.className = 'keyword';
    pill.textContent = `${entry.term} ${entry.count}`;
    group.append(pill);
  }

  keywordCloud.append(group);
}

function renderHours(hourly) {
  if (!window.echarts || !hourChartEl) {
    hourChartEl.innerHTML = '<div class="muted-note">ECharts 未加载。</div>';
    return;
  }

  const labels = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);
  const posts = hourly.map((row) => Number(row.post_count) || 0);
  const replies = hourly.map((row) => Number(row.reply_count) || 0);
  const likes = hourly.map((row) => Number(row.like_count) || 0);

  hourChart ||= window.echarts.init(hourChartEl, null, { renderer: 'canvas' });
  ensureHourChartResize();
  hourChart.setOption({
    color: ['#0f8f72', '#1d6fbb', '#c46a24'],
    animationDuration: 260,
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'shadow'
      },
      valueFormatter: (value) => number(value)
    },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 10,
      textStyle: {
        color: '#687680',
        fontSize: 12
      }
    },
    grid: {
      left: 42,
      right: 18,
      top: 48,
      bottom: 38
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisTick: {
        alignWithLabel: true
      },
      axisLabel: {
        interval: 2,
        color: '#687680',
        fontSize: 11
      },
      axisLine: {
        lineStyle: {
          color: '#d9e0e6'
        }
      }
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: {
        color: '#687680',
        fontSize: 11,
        formatter: (value) => number(value)
      },
      splitLine: {
        lineStyle: {
          color: '#eef2f5'
        }
      }
    },
    series: [
      {
        name: '发帖',
        type: 'bar',
        stack: 'activity',
        emphasis: { focus: 'series' },
        data: posts
      },
      {
        name: '回复',
        type: 'bar',
        stack: 'activity',
        emphasis: { focus: 'series' },
        data: replies
      },
      {
        name: '点赞',
        type: 'bar',
        stack: 'activity',
        emphasis: { focus: 'series' },
        data: likes
      }
    ]
  }, true);

  requestAnimationFrame(() => {
    hourChart?.resize();
  });
}

function ensureHourChartResize() {
  if (hourChartResizeObserver || !window.ResizeObserver) return;

  hourChartResizeObserver = new ResizeObserver(() => {
    hourChart?.resize();
  });
  hourChartResizeObserver.observe(hourChartEl);
}

function renderDaily(rows) {
  dailyTable.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.day || '-')}</td>
      <td>${number(row.item_count)}</td>
      <td>${number(row.reply_items)}</td>
      <td>${decimal(row.avg_likes)}</td>
      <td>${decimal(row.avg_replies)}</td>
    `;
    dailyTable.append(tr);
  }
}

function renderRecent(items) {
  recentItems.innerHTML = '';

  if (!items.length) {
    recentItems.innerHTML = '<div class="muted-note">还没有抓到 timeline 帖子。</div>';
    return;
  }

  for (const item of items.slice(0, 200)) {
    const div = document.createElement('div');
    div.className = 'recent-item';
    const href = item.item_url || `https://x.com/${item.author_handle || ''}/status/${item.item_key}`;
    div.innerHTML = `
      <div>
        <p class="tweet-text">${escapeHtml(item.text_content || '没有抓到正文，可能是纯图片/视频或页面尚未加载完成。')}</p>
        <div class="metric-row item-meta">
          ${escapeHtml(formatDateTime(item.authored_at || item.first_seen_at))}
          · ${escapeHtml(item.kind || 'status')}
          · by @${escapeHtml(item.author_handle || '?')}
          · <a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">${escapeHtml(item.item_key)}</a>
        </div>
      </div>
      <div class="metric-row item-metrics">
        回复 ${number(item.reply_count)} · 转发 ${number(item.repost_count)} · 赞 ${number(item.like_count)}
      </div>
    `;
    recentItems.append(div);
  }
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function number(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function decimal(value) {
  if (value === null || value === undefined) return '-';
  return Number(value).toFixed(1);
}

function topMatches(texts, pattern, limit) {
  const counts = new Map();
  for (const text of texts) {
    const matches = text.match(pattern) || [];
    for (const match of matches) {
      const term = match.toLowerCase();
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }
  return sortCounts(counts).slice(0, limit);
}

function topTerms(texts, limit) {
  const counts = new Map();
  for (const text of texts) {
    for (const term of tokenize(text)) {
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }
  return sortCounts(counts).slice(0, limit);
}

function tokenize(text) {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[A-Za-z0-9_]{1,15}/g, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ');

  if (Intl.Segmenter) {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    return [...segmenter.segment(cleaned)]
      .filter((part) => part.isWordLike)
      .map((part) => normalizeTerm(part.segment))
      .filter(Boolean);
  }

  return (cleaned.match(/[\p{L}\p{N}_]{2,}/gu) || [])
    .map(normalizeTerm)
    .filter(Boolean);
}

function normalizeTerm(term) {
  const normalized = String(term || '').toLowerCase().trim();
  if (normalized.length < 2) return null;
  if (/^\d+$/.test(normalized)) return null;
  if (STOP_WORDS.has(normalized)) return null;
  return normalized;
}

function sortCounts(counts) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term, count]) => ({ term, count }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}
