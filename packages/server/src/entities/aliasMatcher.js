const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokenize = (s) => { const n = normalize(s); return n ? n.split(' ') : []; };

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function aliasesFor(value, configured) {
  const set = new Set();
  // Short values (e.g. group "we"/"you") are common words: only match them via explicit aliases.
  const implicit = configured.length > 0 && normalize(value).length <= 3 ? [] : [value];
  for (const a of [...configured, ...implicit]) {
    const n = normalize(a);
    if (n) set.add(n);
  }
  const compact = normalize(value).replace(/ /g, '');
  if (compact.endsWith('ui') && compact.length > 4) set.add(compact.slice(0, -2));
  return [...set].map((text) => ({ tokens: text.split(' '), compact: text.replace(/ /g, '') }));
}

export function createAliasMatcher(entities) {
  const index = {};
  for (const [type, vals] of Object.entries(entities || {})) {
    index[type] = Object.entries(vals).map(([value, aliases]) => ({
      value,
      aliases: aliasesFor(value, aliases || []),
    }));
  }

  function exactSpan(alias, msg) {
    let best = 0;
    const n = alias.tokens.length;
    for (let i = 0; i + n <= msg.length; i++) {
      if (alias.tokens.every((t, k) => msg[i + k] === t)) best = Math.max(best, n);
    }
    for (let len = 1; len <= 3; len++) {
      for (let i = 0; i + len <= msg.length; i++) {
        if (msg.slice(i, i + len).join('') === alias.compact) best = Math.max(best, len);
      }
    }
    return best;
  }

  function matchType(entries, msg) {
    let best = 0;
    let hits = new Set();
    for (const { value, aliases } of entries) {
      for (const alias of aliases) {
        const span = exactSpan(alias, msg);
        if (!span) continue;
        if (span > best) { best = span; hits = new Set(); }
        if (span === best) hits.add(value);
      }
    }
    if (hits.size === 1) return { value: [...hits][0] };
    if (hits.size > 1) return { candidates: [...hits].sort() };

    const windows = [];
    for (let i = 0; i < msg.length; i++) {
      windows.push(msg[i]);
      if (i + 1 < msg.length) windows.push(msg[i] + msg[i + 1]);
    }
    const fuzzy = new Set();
    for (const { value, aliases } of entries) {
      for (const alias of aliases) {
        if (alias.compact.length < 5) continue;
        if (windows.some((w) => w.length >= 5 && levenshtein(w, alias.compact) <= (alias.compact.length >= 10 ? 2 : 1))) fuzzy.add(value);
      }
    }
    return fuzzy.size === 1 ? { value: [...fuzzy][0] } : null;
  }

  return {
    match(message) {
      const msg = tokenize(message);
      const out = {};
      for (const [type, entries] of Object.entries(index)) {
        const r = matchType(entries, msg);
        if (r) out[type] = r;
      }
      return out;
    },
    values(type) {
      return (index[type] || []).map((e) => e.value);
    },
  };
}
