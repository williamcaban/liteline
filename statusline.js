#!/usr/bin/env node
// Claude Code status line — reads StatusJSON from stdin, prints one line.
// No external dependencies; pure Node.js.

const RESET  = '\x1b[0m';
const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const YELLOW = '\x1b[33m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';

function ctxColor(pct) {
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

function shortModel(name) {
  if (!name) return null;
  // "claude-sonnet-4-6[1m]" → "Sonnet 4.6 1M"
  // "Opus 4.6 (1M context)"  → already readable, truncate if long
  return name.length > 24 ? name.slice(0, 22) + '…' : name;
}

async function readStdin() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join('');
}

(async () => {
  let raw;
  try { raw = await readStdin(); } catch { process.exit(1); }

  if (!raw || !raw.trim()) process.exit(0);

  let d;
  try { d = JSON.parse(raw); } catch {
    process.stderr.write('cc-statusline: invalid JSON\n');
    process.exit(1);
  }

  const SEP = `${DIM} │ ${RESET}`;
  const parts = [];

  // Model
  const model = shortModel(d.model?.display_name ?? d.model?.id);
  if (model) parts.push(`${CYAN}${model}${RESET}`);

  // Session cost
  const cost = formatCost(d.cost?.total_cost_usd);
  if (cost) parts.push(`${YELLOW}${BOLD}${cost}${RESET}`);

  // Context window %
  const pct = d.context_window?.used_percentage;
  if (pct != null) {
    const col = ctxColor(pct);
    parts.push(`${col}${pct}%${RESET}${DIM} ctx${RESET}`);
  }

  // Total tokens this session (input + output)
  const totalIn  = d.context_window?.total_input_tokens;
  const totalOut = d.context_window?.total_output_tokens;
  if (totalIn != null && totalOut != null) {
    const tok = totalIn + totalOut;
    const fmt = tok >= 1_000_000
      ? `${(tok / 1_000_000).toFixed(1)}M`
      : tok >= 1_000
        ? `${Math.round(tok / 1_000)}k`
        : `${tok}`;
    parts.push(`${DIM}${fmt} tok${RESET}`);
  }

  // Session duration
  const dur = formatDuration(d.cost?.total_duration_ms);
  if (dur) parts.push(`${DIM}${dur}${RESET}`);

  process.stdout.write(parts.join(SEP) + '\n');
})();
