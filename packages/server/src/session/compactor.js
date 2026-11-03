const LIMITS = [[20, 500], [10, 200], [5, 100], [3, 60]];

export function estimateTokens(x) {
  return Math.ceil(JSON.stringify(x).length / 4);
}

function shrink(value, arrMax, strMax) {
  if (typeof value === 'string') {
    return value.length > strMax ? value.slice(0, strMax) + '…' : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, arrMax).map((v) => shrink(v, arrMax, strMax));
    if (value.length > arrMax) items.push(`… ${value.length - arrMax} more`);
    return items;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shrink(v, arrMax, strMax);
    return out;
  }
  return value;
}

export function compact(data, { maxTokens = 1500 } = {}) {
  if (estimateTokens(data) <= maxTokens) return data;
  for (const [arrMax, strMax] of LIMITS) {
    const out = shrink(data, arrMax, strMax);
    if (estimateTokens(out) <= maxTokens) return out;
  }
  const full = JSON.stringify(data);
  const wrap = (n) => ({ truncated: true, preview: full.slice(0, n) });
  let lo = 0;
  let hi = Math.min(full.length, maxTokens * 4);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(wrap(mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return wrap(lo);
}
