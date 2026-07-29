#!/usr/bin/env node
// Copyright 2026 William Caban
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// liteline — Claude Code status line
// Cost, context, tokens, rate limits, compaction. No external dependencies.

const RESET   = '\x1b[0m';
const DIM     = '\x1b[2m';
const BOLD    = '\x1b[1m';
const YELLOW  = '\x1b[33m';
const GREEN   = '\x1b[32m';
const RED     = '\x1b[31m';
const CYAN    = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function pctColor(pct) {
  if (pct >= 85) return RED;
  if (pct >= 60) return YELLOW;
  return GREEN;
}

function formatCost(usd) {
  if (usd == null) return null;
  if (usd < 0.001) return `<$0.001`;
  if (usd < 0.01)  return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) { const rs = s % 60; return rs > 0 ? `${m}m${rs}s` : `${m}m`; }
  const h = Math.floor(m / 60);
  if (h < 24) { const rm = m % 60; return rm > 0 ? `${h}h${rm}m` : `${h}h`;  }
  const d = Math.floor(h / 24); const rh = h % 24;
  return rh > 0 ? `${d}d${rh}h` : `${d}d`;
}

function formatCountdown(seconds) {
  if (seconds <= 0) return 'now';
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}d${rh}h` : `${d}d`;
  }
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function shortModel(name) {
  if (!name) return null;
  return name.length > 24 ? name.slice(0, 22) + '…' : name;
}

async function readStdin() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join('');
}

// Upsert this session's cost into ~/.cache/liteline/costs.json and return
// the running total for the current calendar month.
// Cache schema: { sessions: { [id]: { cost, date } } }
// Sessions older than 60 days are pruned on each write.
async function updateAndGetMonthlyTotal(sessionId, costUsd) {
  if (!sessionId || costUsd == null) return null;
  try {
    const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('fs');
    const { homedir } = await import('os');
    const { join } = await import('path');

    const cacheDir  = join(homedir(), '.cache', 'liteline');
    const cacheFile = join(cacheDir, 'costs.json');
    const today     = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
    const thisMonth = today.slice(0, 7);                        // YYYY-MM
    const cutoff    = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Read existing cache
    let data = { sessions: {} };
    if (existsSync(cacheFile)) {
      try { data = JSON.parse(readFileSync(cacheFile, 'utf8')); }
      catch { /* start fresh on corrupt cache */ }
      if (!data?.sessions) data = { sessions: {} };
    }

    // Upsert current session and prune old entries in one pass
    const sessions = {};
    for (const [id, entry] of Object.entries(data.sessions)) {
      if (entry.date >= cutoffStr) sessions[id] = entry;
    }

    // Delta-based accumulation with /clear detection.
    //
    // `lastCostUsd` is the raw payload value we saw on the previous refresh.
    // On each refresh we add only the INCREMENT (costUsd - lastCostUsd) to the
    // running total, not the full value — so the cache does not double-count.
    //
    // When costUsd < lastCostUsd the session was reset (/clear or restart).
    // We treat costUsd itself as the first delta from a new zero baseline and
    // add it in full, then resume delta tracking from there.
    const existing = sessions[sessionId];
    const lastKnown = existing?.lastCostUsd ?? existing?.cost ?? 0;
    let newCost;
    if (!existing) {
      newCost = costUsd;                          // first observation
    } else if (costUsd >= lastKnown) {
      newCost = existing.cost + (costUsd - lastKnown); // normal delta
    } else {
      newCost = existing.cost + costUsd;          // reset: add post-clear total
    }
    sessions[sessionId] = { cost: newCost, lastCostUsd: costUsd, date: today };
    data.sessions = sessions;

    // Compute monthly total before writing (so a write failure still returns a value)
    const monthly = Object.values(sessions)
      .filter(e => e.date.startsWith(thisMonth))
      .reduce((sum, e) => sum + (e.cost ?? 0), 0);

    // Write cache (best-effort)
    try {
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(data));
    } catch { /* ignore write errors */ }

    return monthly;
  } catch {
    return null;
  }
}

// Stream JSONL transcript and count compact_boundary markers.
// Format: {type:'system', subtype:'compact_boundary', isSidechain: !true}
async function getCompactionCount(transcriptPath) {
  if (!transcriptPath) return 0;
  try {
    const { createReadStream } = await import('fs');
    const { createInterface } = await import('readline');
    const rl = createInterface({ input: createReadStream(transcriptPath), crlfDelay: Infinity });
    let count = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'system' && e.subtype === 'compact_boundary' && e.isSidechain !== true) count++;
      } catch { /* skip malformed lines */ }
    }
    return count;
  } catch {
    return 0;
  }
}

// Format one rate-limit window: "5h:42% ↺2h15m"
function formatRateWindow(window, label) {
  if (!window) return null;
  const pct = window.used_percentage;
  if (pct == null) return null;
  let s = `${DIM}${label}:${RESET}${pctColor(pct)}${pct}%${RESET}`;
  if (window.resets_at) {
    const remaining = window.resets_at - Math.floor(Date.now() / 1000);
    s += `${DIM} ↺${formatCountdown(remaining)}${RESET}`;
  }
  return s;
}

(async () => {
  let raw;
  try { raw = await readStdin(); } catch { process.exit(1); }
  if (!raw || !raw.trim()) process.exit(0);

  let d;
  try { d = JSON.parse(raw); } catch {
    process.stderr.write('liteline: invalid JSON\n');
    process.exit(1);
  }

  // Kick off async work concurrently while formatting everything else.
  const compactionPromise = getCompactionCount(d.transcript_path);
  const monthlyPromise    = updateAndGetMonthlyTotal(d.session_id, d.cost?.total_cost_usd);

  const SEP  = `${DIM} │ ${RESET}`;   // within-segment separator
  const SSEP = `${DIM} ║ ${RESET}`;   // between-segment separator

  // ── Session segment ────────────────────────────────────────────────
  const session = [];

  const model = shortModel(d.model?.display_name ?? d.model?.id);
  if (model) session.push(`${CYAN}${model}${RESET}`);

  const cost = formatCost(d.cost?.total_cost_usd);
  const monthly = await monthlyPromise;
  if (cost) {
    const monthlyStr = monthly != null ? `${DIM} (~${formatCost(monthly)}/mo)${RESET}` : '';
    session.push(`${YELLOW}${BOLD}${cost}${RESET}${monthlyStr}`);
  }

  const pct = d.context_window?.used_percentage;
  if (pct != null) session.push(`${pctColor(pct)}${pct}%${RESET}${DIM} ctx${RESET}`);

  const totalIn  = d.context_window?.total_input_tokens;
  const totalOut = d.context_window?.total_output_tokens;
  if (totalIn != null && totalOut != null) {
    const tok = totalIn + totalOut;
    const fmt = tok >= 1_000_000 ? `${(tok/1_000_000).toFixed(1)}M`
              : tok >= 1_000     ? `${Math.round(tok/1_000)}k`
              : `${tok}`;
    session.push(`${DIM}${fmt} tok${RESET}`);
  }

  const dur = formatDuration(d.cost?.total_duration_ms);
  if (dur) session.push(`${DIM}${dur}${RESET}`);

  // ── Rate limits segment ────────────────────────────────────────────
  const rateParts = [
    formatRateWindow(d.rate_limits?.five_hour, '5h'),
    formatRateWindow(d.rate_limits?.seven_day, '7d'),
  ].filter(Boolean);

  // ── Compaction segment ─────────────────────────────────────────────
  const compactions = await compactionPromise;

  // ── Assemble ───────────────────────────────────────────────────────
  const segments = [
    session.join(SEP),
    rateParts.length ? rateParts.join(`  `) : '',
    compactions > 0  ? `${MAGENTA}⟳${compactions}${RESET}` : '',
  ].filter(s => s.length > 0);

  process.stdout.write(segments.join(SSEP) + '\n');
})();
