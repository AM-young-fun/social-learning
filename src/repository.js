import { authoredAtFromXItem } from './x-time.js';

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

export class Repository {
  constructor(db) {
    this.db = db;

    this.getProfileByHandleStmt = db.prepare(`
      SELECT * FROM profiles WHERE platform = ? AND lower(handle) = lower(?)
    `);
    this.upsertProfileStmt = db.prepare(`
      INSERT INTO profiles (platform, handle, display_name, profile_url, first_seen_at, last_seen_at, visit_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(platform, handle) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, profiles.display_name),
        profile_url = COALESCE(excluded.profile_url, profiles.profile_url),
        last_seen_at = excluded.last_seen_at,
        visit_count = profiles.visit_count + 1
    `);
    this.insertVisitStmt = db.prepare(`
      INSERT INTO profile_visits (profile_id, observed_at, page_url, source)
      VALUES (?, ?, ?, ?)
    `);
    this.upsertItemStmt = db.prepare(`
      INSERT INTO timeline_items (
        profile_id, platform, item_key, item_url, author_handle, authored_at, kind,
        text_content, first_seen_at, last_seen_at, observed_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(profile_id, platform, item_key) DO UPDATE SET
        item_url = COALESCE(excluded.item_url, timeline_items.item_url),
        author_handle = COALESCE(excluded.author_handle, timeline_items.author_handle),
        authored_at = COALESCE(excluded.authored_at, timeline_items.authored_at),
        kind = COALESCE(excluded.kind, timeline_items.kind),
        text_content = COALESCE(excluded.text_content, timeline_items.text_content),
        last_seen_at = excluded.last_seen_at,
        observed_count = timeline_items.observed_count + 1
    `);
    this.getItemStmt = db.prepare(`
      SELECT * FROM timeline_items WHERE profile_id = ? AND platform = ? AND item_key = ?
    `);
    this.insertObservationStmt = db.prepare(`
      INSERT INTO timeline_observations (
        timeline_item_id, observed_at, reply_count, repost_count, like_count,
        quote_count, view_count, bookmark_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  recordProfile(input) {
    const now = isoNow();
    const platform = input.platform || 'x';
    const handle = normalizeHandle(input.handle);

    this.upsertProfileStmt.run(
      platform,
      handle,
      nullableString(input.displayName),
      nullableString(input.profileUrl),
      input.observedAt || now,
      input.observedAt || now
    );

    const profile = this.getProfileByHandleStmt.get(platform, handle);
    this.insertVisitStmt.run(
      profile.id,
      input.observedAt || now,
      nullableString(input.pageUrl || input.profileUrl),
      nullableString(input.source) || 'extension'
    );

    return profile;
  }

  recordTimelineBatch(input) {
    const now = isoNow();
    const platform = input.platform || 'x';
    const handle = normalizeHandle(input.profileHandle || input.handle);
    const profile = this.getProfileByHandleStmt.get(platform, handle) || this.recordProfile({
      platform,
      handle,
      displayName: input.displayName,
      profileUrl: input.profileUrl,
      pageUrl: input.pageUrl,
      source: input.source,
      observedAt: input.observedAt || now
    });

    const safeItems = Array.isArray(input.items) ? input.items.slice(0, 200) : [];
    const tx = this.db.prepare('SELECT 1');
    const inserted = [];

    this.db.exec('BEGIN');
    try {
      for (const item of safeItems) {
        const itemKey = nullableString(item.itemKey || item.statusId || item.itemUrl);
        if (!itemKey) continue;

        this.upsertItemStmt.run(
          profile.id,
          platform,
          itemKey,
          nullableString(item.itemUrl),
          normalizeOptionalHandle(item.authorHandle),
          authoredAtFromXItem(item),
          nullableString(item.kind),
          nullableLongString(item.textContent),
          input.observedAt || now,
          input.observedAt || now
        );

        const stored = this.getItemStmt.get(profile.id, platform, itemKey);
        this.insertObservationStmt.run(
          stored.id,
          input.observedAt || now,
          nullableNumber(item.replyCount),
          nullableNumber(item.repostCount),
          nullableNumber(item.likeCount),
          nullableNumber(item.quoteCount),
          nullableNumber(item.viewCount),
          nullableNumber(item.bookmarkCount)
        );
        inserted.push(stored.id);
      }
      tx.get();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return { profile, observedItems: inserted.length };
  }

  listProfiles() {
    return this.db.prepare(`
      SELECT
        p.*,
        COUNT(DISTINCT ti.id) AS item_count,
        MAX(ti.authored_at) AS latest_authored_at
      FROM profiles p
      LEFT JOIN timeline_items ti ON ti.profile_id = p.id
      GROUP BY p.id
      ORDER BY p.last_seen_at DESC
    `).all();
  }

  getProfileSummary(handle, days = 30) {
    const profile = this.getProfileByHandleStmt.get('x', normalizeHandle(handle));
    if (!profile) return null;

    const since = new Date(Date.now() - clampDays(days) * 24 * 60 * 60 * 1000).toISOString();
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS item_count,
        SUM(CASE WHEN text_content IS NOT NULL AND text_content != '' THEN 1 ELSE 0 END) AS text_item_count
      FROM timeline_items
      WHERE profile_id = ?
    `).get(profile.id);

    const daily = this.db.prepare(`
      SELECT
        substr(COALESCE(authored_at, first_seen_at), 1, 10) AS day,
        COUNT(*) AS item_count,
        SUM(CASE WHEN lower(kind) = 'reply' THEN 1 ELSE 0 END) AS reply_items,
        AVG(latest.like_count) AS avg_likes,
        AVG(latest.reply_count) AS avg_replies,
        AVG(latest.repost_count) AS avg_reposts
      FROM timeline_items ti
      LEFT JOIN (
        SELECT timeline_item_id, like_count, reply_count, repost_count
        FROM timeline_observations
        WHERE id IN (
          SELECT MAX(id)
          FROM timeline_observations
          GROUP BY timeline_item_id
        )
      ) latest ON latest.timeline_item_id = ti.id
      WHERE ti.profile_id = ? AND COALESCE(authored_at, first_seen_at) >= ?
      GROUP BY day
      ORDER BY day DESC
    `).all(profile.id, since);

    const hourly = this.db.prepare(`
      SELECT
        strftime('%H', COALESCE(authored_at, first_seen_at)) AS hour,
        COUNT(*) AS item_count,
        SUM(CASE WHEN lower(COALESCE(kind, '')) = 'reply' THEN 1 ELSE 0 END) AS reply_count,
        SUM(CASE WHEN lower(COALESCE(kind, '')) != 'reply' THEN 1 ELSE 0 END) AS post_count,
        SUM(COALESCE(latest.like_count, 0)) AS like_count
      FROM timeline_items ti
      LEFT JOIN (
        SELECT timeline_item_id, like_count
        FROM timeline_observations
        WHERE id IN (
          SELECT MAX(id)
          FROM timeline_observations
          GROUP BY timeline_item_id
        )
      ) latest ON latest.timeline_item_id = ti.id
      WHERE ti.profile_id = ? AND COALESCE(authored_at, first_seen_at) >= ?
      GROUP BY hour
      ORDER BY hour
    `).all(profile.id, since);

    const recentItems = this.db.prepare(`
      SELECT
        ti.*,
        latest.reply_count,
        latest.repost_count,
        latest.like_count,
        latest.quote_count,
        latest.view_count,
        latest.bookmark_count
      FROM timeline_items ti
      LEFT JOIN (
        SELECT *
        FROM timeline_observations
        WHERE id IN (
          SELECT MAX(id)
          FROM timeline_observations
          GROUP BY timeline_item_id
        )
      ) latest ON latest.timeline_item_id = ti.id
      WHERE ti.profile_id = ?
      ORDER BY COALESCE(ti.authored_at, ti.first_seen_at) DESC
      LIMIT 500
    `).all(profile.id);

    return { profile, totals, daily, hourly, recentItems };
  }

  listEvents(limit = 100) {
    return this.db.prepare(`
      SELECT
        p.handle,
        p.display_name,
        ti.item_key,
        ti.item_url,
        ti.author_handle,
        ti.authored_at,
        ti.kind,
        ti.text_content,
        obs.observed_at,
        obs.reply_count,
        obs.repost_count,
        obs.like_count,
        obs.quote_count,
        obs.view_count
      FROM timeline_observations obs
      JOIN timeline_items ti ON ti.id = obs.timeline_item_id
      JOIN profiles p ON p.id = ti.profile_id
      ORDER BY obs.observed_at DESC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 100, 1), 500));
  }

  exportAll() {
    return {
      exportedAt: isoNow(),
      profiles: this.db.prepare('SELECT * FROM profiles ORDER BY last_seen_at DESC').all(),
      visits: this.db.prepare('SELECT * FROM profile_visits ORDER BY observed_at DESC').all(),
      timelineItems: this.db.prepare('SELECT * FROM timeline_items ORDER BY last_seen_at DESC').all(),
      observations: this.db.prepare('SELECT * FROM timeline_observations ORDER BY observed_at DESC').all()
    };
  }
}

function normalizeHandle(handle) {
  const normalized = String(handle || '').replace(/^@/, '').trim();
  if (!HANDLE_RE.test(normalized)) {
    throw new InputError('Invalid X handle.');
  }
  return normalized;
}

function normalizeOptionalHandle(handle) {
  if (!handle) return null;
  const normalized = String(handle).replace(/^@/, '').trim();
  return HANDLE_RE.test(normalized) ? normalized : null;
}

function nullableString(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function nullableLongString(value) {
  const text = nullableString(value);
  return text ? text.slice(0, 8000) : null;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampDays(days) {
  return Math.min(Math.max(Number(days) || 30, 1), 366);
}

function isoNow() {
  return new Date().toISOString();
}

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}
