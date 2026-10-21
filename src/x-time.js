const X_SNOWFLAKE_EPOCH = 1288834974657n;

export function authoredAtFromXItem(item) {
  return nullableIso(item?.authoredAt) || isoFromStatusId(item?.statusId || item?.itemKey || statusIdFromUrl(item?.itemUrl));
}

export function isoFromStatusId(value) {
  const text = String(value || '').trim();
  if (!/^\d{10,}$/.test(text)) return null;

  try {
    const timestamp = (BigInt(text) >> 22n) + X_SNOWFLAKE_EPOCH;
    const date = new Date(Number(timestamp));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

export function statusIdFromUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(String(value), 'https://x.com');
    return url.pathname.match(/\/status\/([^/?#]+)/)?.[1] || null;
  } catch {
    return null;
  }
}

function nullableIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
