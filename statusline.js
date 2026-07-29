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
  const r = s % 60;
  return r > 0 ? `${m}m${r}s` : `${m}m`;
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

  // Kick off compaction count concurrently while formatting everything else.
  const compactionPromise = getCompactionCount(d.transcript_path);

  const SEP  = `${DIM} │ ${RESET}`;   // within-segment separator
  const SSEP = `${DIM} ║ ${RESET}`;   // between-segment separator

  // ── Session segment ────────────────────────────────────────────────
  const session = [];

  const model = shortModel(d.model?.display_name ?? d.model?.id);
  if (model) session.push(`${CYAN}${model}${RESET}`);

  const cost = formatCost(d.cost?.total_cost_usd);
  if (cost) session.push(`${YELLOW}${BOLD}${cost}${RESET}`);

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
