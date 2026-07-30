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

// #11 — top-level imports (visible dependencies, no per-call overhead)
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join }    from 'path';
import { createInterface } from 'readline';

// ── ANSI ────────────────────────────────────────────────────────────────────
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

// #10 — guard against negative cost (corrupted payload or API quirk)
function formatCost(usd) {
  if (usd == null || usd < 0) return null;
  if (usd < 0.001) return `<$0.001`;
  if (usd < 0.01)  return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// #2, #6 — shared seconds-to-human formatter used by both formatDuration and
// formatCountdown, eliminating the duplicate tier logic and the Math.ceil
// artifact that could produce "60m".
//
// showSecs : include seconds in the sub-hour tier (duration) vs minutes only (countdown)
// zeroStr  : return value when s <= 0 (null for duration, 'now' for countdown)
function _secsToHuman(s, showSecs, zeroStr) {
  if (s <= 0) return zeroStr;
  if (s < 60)  return showSecs ? `${s}s` : `1m`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    if (showSecs) { const rs = s % 60; return rs > 0 ? `${m}m${rs}s` : `${m}m`; }
    return `${m}m`;
  }
  const h  = Math.floor(m / 60); const rm = m % 60;
  if (h < 24) return rm > 0 ? `${h}h${rm}m` : `${h}h`;
  const d  = Math.floor(h / 24); const rh = h % 24;
  return rh > 0 ? `${d}d${rh}h` : `${d}d`;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return null;
  return _secsToHuman(Math.floor(ms / 1000), true, null);
}

function formatCountdown(secs) {
  return _secsToHuman(Math.floor(secs), false, 'now');
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

// ── Monthly cost cache ──────────────────────────────────────────────────────
// #9 — allow override via env var for testing or non-standard setups
const CACHE_DIR  = process.env.LITELINE_CACHE_DIR ?? join(homedir(), '.cache', 'liteline');
const CACHE_FILE = join(CACHE_DIR, 'costs.json');

// #1 — separated read/write; retry once to tolerate a concurrent rename landing
// between our open() and read(). Returns a guaranteed-valid structure.
function readCache() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      if (data && typeof data.sessions === 'object') return data;
    } catch { /* retry */ }
  }
  return { sessions: {} };
}

// #1 — atomic write: write to a PID-unique temp file then rename.
// On POSIX, rename(2) is atomic: concurrent readers see the old or new file,
// never a partial write. PID in the name prevents two writers clobbering each
// other's temp file (last rename wins — a lost update, not corruption).
function writeCache(data) {
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, CACHE_FILE);
  } catch { /* stale cache is better than a crash */ }
}

async function updateAndGetMonthlyTotal(sessionId, costUsd) {
  if (!sessionId || costUsd == null || costUsd < 0) return null;
  try {
    const today     = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
    const month     = today.slice(0, 7);                       // YYYY-MM
    const cutoff    = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const data = readCache();

    // #4 — prune + validate in one pass: drop old and corrupt entries
    const sessions = {};
    for (const [id, e] of Object.entries(data.sessions ?? {})) {
      if (typeof e?.cost === 'number' && isFinite(e.cost)
          && typeof e?.date === 'string' && e.date >= cutoffStr) {
        sessions[id] = e;
      }
    }

    // Delta-based accumulation with /clear detection (see earlier commit)
    const existing  = sessions[sessionId];
    const lastKnown = existing?.lastCostUsd ?? existing?.cost ?? 0;
    const newCost   = !existing            ? costUsd
                    : costUsd >= lastKnown ? existing.cost + (costUsd - lastKnown)
                    :                        existing.cost + costUsd;
    sessions[sessionId] = { cost: newCost, lastCostUsd: costUsd, date: today };

    const monthly = Object.values(sessions)
      .filter(e => e.date.startsWith(month))
      .reduce((sum, e) => sum + e.cost, 0);

    writeCache({ sessions });
    return monthly;
  } catch {
    return null;
  }
}

// ── Compaction counter ──────────────────────────────────────────────────────
// #5 — 2 s timeout so a large transcript never stalls the status bar
async function getCompactionCount(transcriptPath) {
  if (!transcriptPath) return 0;

  const scan = async () => {
    try {
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
    } catch { return 0; }
  };

  return Promise.race([scan(), new Promise(r => setTimeout(() => r(0), 2000))]);
}

// ── Rate limit window ───────────────────────────────────────────────────────
// #8 — renamed parameter: 'window' → 'bucket' (avoids shadowing global identifier)
function formatRateWindow(bucket, label) {
  if (!bucket) return null;
  const pct = bucket.used_percentage;
  if (pct == null) return null;
  let s = `${DIM}${label}:${RESET}${pctColor(pct)}${pct}%${RESET}`;
  if (bucket.resets_at) {
    const remaining = bucket.resets_at - Math.floor(Date.now() / 1000);
    s += `${DIM} ↺${formatCountdown(remaining)}${RESET}`;
  }
  return s;
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  let raw;
  try { raw = await readStdin(); } catch { process.exit(1); }
  if (!raw || !raw.trim()) process.exit(0);

  let d;
  try { d = JSON.parse(raw); } catch {
    process.stderr.write('liteline: invalid JSON\n');
    process.exit(1);
  }

  // #7 — both async tasks start concurrently; single await collects both results
  const [compactions, monthly] = await Promise.all([
    getCompactionCount(d.transcript_path),
    updateAndGetMonthlyTotal(d.session_id, d.cost?.total_cost_usd),
  ]);

  const SEP  = `${DIM} │ ${RESET}`;
  const SSEP = `${DIM} ║ ${RESET}`;

  // ── Session segment ────────────────────────────────────────────────────
  const session = [];

  const model = shortModel(d.model?.display_name ?? d.model?.id);
  if (model) session.push(`${CYAN}${model}${RESET}`);

  const cost = formatCost(d.cost?.total_cost_usd);
  if (cost) {
    // #3 — suppress monthly when negligible (avoids "~<$0.001/mo" on session start)
    const monthlyStr = (monthly != null && monthly >= 0.001)
      ? `${DIM} (~${formatCost(monthly)}/mo)${RESET}`
      : '';
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

  // ── Rate limits segment ────────────────────────────────────────────────
  const rateParts = [
    formatRateWindow(d.rate_limits?.five_hour, '5h'),
    formatRateWindow(d.rate_limits?.seven_day, '7d'),
  ].filter(Boolean);

  // ── Assemble ──────────────────────────────────────────────────────────
  const segments = [
    session.join(SEP),
    rateParts.length ? rateParts.join(`  `) : '',
    compactions > 0  ? `${MAGENTA}⟳${compactions}${RESET}` : '',
  ].filter(s => s.length > 0);

  process.stdout.write(segments.join(SSEP) + '\n');
})();
