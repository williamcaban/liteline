# liteline

A minimal, zero-dependency status line for [Claude Code](https://claude.ai/code).
Shows session cost, monthly spend, context window usage, token counts, API rate
limits, and compaction count. No network calls, no keychain access, no npm packages
to audit.

```
Opus 4.6 (1M context) │ $0.12 (~$18.07/mo) │ 42% ctx │ 60k tok │ 4m30s ║ 5h:42% ↺2h15m  7d:15% ↺3d5h ║ ⟳2
```

---

## What it shows

The output is divided into three sections separated by `║`.

### Session (always shown)

| Field | Example | Description |
|---|---|---|
| Model name | `Opus 4.6 (1M context)` | Display name from the payload, truncated to 24 chars |
| Session cost | `$0.12` | Cumulative cost for the current session in USD |
| Monthly total | `(~$18.07/mo)` | Running total for the current calendar month (see below) |
| Context % | `42% ctx` | Context window used — green < 60%, yellow < 85%, red ≥ 85% |
| Tokens | `60k tok` | Total input + output tokens this session |
| Duration | `4m30s` | Wall-clock session time |

### Rate limits (shown when Claude Code reports them)

| Field | Example | Description |
|---|---|---|
| 5-hour window | `5h:42%` | Rolling 5-hour usage — same color scale as context % |
| Reset countdown | `↺2h15m` | Time until the 5-hour window resets |
| 7-day window | `7d:15%` | Rolling 7-day usage |
| Reset countdown | `↺3d5h` | Time until the weekly window resets |

Rate limit data appears in Claude Code ≥ 2.1.x. If your version does not include
it, this section is silently omitted.

### Compaction (shown only when > 0)

| Field | Example | Description |
|---|---|---|
| Compaction count | `⟳2` | Number of context compactions in this session |

Compaction is counted by scanning the session transcript for
`{type: "system", subtype: "compact_boundary"}` markers that Claude Code writes
on every compaction event. Sidechain (subagent) entries are excluded.

---

## Monthly cost tracking

liteline keeps a local cache at `~/.cache/liteline/costs.json` to accumulate
spend across sessions.

**How it works:**

- On every status line refresh, liteline upserts the current session's cost into
  the cache, keyed by `session_id`.
- The monthly total is the sum of all sessions whose date falls in the current
  calendar month.
- Sessions older than 60 days are pruned automatically on each write.
- The cache is plain JSON — inspect or edit it at any time.

**What to expect:**

- The monthly total only includes sessions where liteline was active. It cannot
  retroactively count spend from before liteline was installed.
- The `~` prefix signals an estimate: each session's cost in the cache reflects
  the last known value at the time liteline ran, not necessarily the final cost
  if the session is still open.
- Month boundaries reset automatically — totals start fresh on the 1st of each month.

**Cache format:**

```json
{
  "sessions": {
    "session-id-abc": { "cost": 0.123, "date": "2026-07-29" },
    "session-id-xyz": { "cost": 9.25,  "date": "2026-07-29" }
  }
}
```

To reset the monthly total, delete or edit `~/.cache/liteline/costs.json`.

---

## Requirements

- **Node.js ≥ 18** — no install, no build step
- **Claude Code** with `statusLine` support (any version that accepts a `command`
  type status line)

---

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/williamcaban/liteline.git
```

Or place it anywhere you like — the path you choose goes into settings in the
next step.

### 2. Make the script executable

```bash
chmod +x liteline/statusline.js
```

### 3. Add to Claude Code settings

Open `~/.claude/settings.json` (create it if it does not exist) and add:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/liteline/statusline.js",
    "padding": 0,
    "refreshInterval": 10
  }
}
```

Replace `/absolute/path/to/liteline` with the full path to the directory where
you cloned the repo. Use an absolute path — Claude Code may invoke the command
from any working directory.

`refreshInterval` is in seconds. `10` is a good default; lower values refresh
faster but run the script more often.

### 4. Verify it works

Pipe a test payload and confirm you see formatted output:

```bash
echo '{
  "session_id": "test-session-001",
  "model": {"display_name": "Opus 4.6 (1M context)"},
  "cost": {"total_cost_usd": 0.123, "total_duration_ms": 270000},
  "context_window": {
    "used_percentage": 42,
    "total_input_tokens": 50000,
    "total_output_tokens": 10000
  },
  "rate_limits": {
    "five_hour": {"used_percentage": 42, "resets_at": 1774020000},
    "seven_day": {"used_percentage": 15, "resets_at": 1774540000}
  }
}' | node /absolute/path/to/liteline/statusline.js
```

You should see a single colored line. If you see a Node.js error instead, check
that your Node.js version is ≥ 18 (`node --version`).

---

## Updating

```bash
cd /path/to/liteline
git pull
```

No rebuild needed — the script runs directly from source.

---

## How it works

Claude Code executes the `command` from `settings.json` every `refreshInterval`
seconds and writes the result to the status bar. It pipes a JSON object
(the `StatusJSON` payload) to the command's stdin. `liteline` reads that payload,
formats it, and prints one line to stdout.

Two pieces of data are not in the payload and require additional local reads,
both of which run concurrently to avoid blocking each other:

- **Compaction counter** — streamed from the session transcript file (path
  provided in the payload). Only compact-boundary marker lines are examined;
  conversation content is never read or stored.
- **Monthly cost** — read from and written to `~/.cache/liteline/costs.json`.
  No data leaves the local machine.

### Payload fields used

```
session_id
model.display_name / model.id
cost.total_cost_usd
cost.total_duration_ms
context_window.used_percentage
context_window.total_input_tokens
context_window.total_output_tokens
rate_limits.five_hour.used_percentage
rate_limits.five_hour.resets_at
rate_limits.seven_day.used_percentage
rate_limits.seven_day.resets_at
transcript_path                        ← used only to count compaction events
```

All fields are optional. If a field is absent, that part of the display is
silently omitted. The script never exits with a non-zero code on missing data.

---

## Security

liteline was written specifically to avoid the concerns that apply to heavier
status line tools:

| Property | Detail |
|---|---|
| No network calls | All data comes from stdin, the local transcript, or the local cache |
| No keychain access | Does not call `security`, `secret-tool`, or any credential store |
| No shell exec | No `exec`, `execSync`, or child processes spawned |
| No npm dependencies | Zero packages to audit or update |
| Minimal filesystem access | Reads the transcript path provided by Claude Code; reads and writes its own cache at `~/.cache/liteline/` |
| Readable source | Single-file script — read it in a few minutes |

---

## Troubleshooting

**Status bar is blank or missing**

- Confirm the path in `settings.json` is absolute and the file exists.
- Run the verification command from step 4 above to check for errors.
- Ensure `statusLine.type` is `"command"` (not `"text"`).

**Monthly total shows `<$0.001` or seems wrong**

- The total only covers sessions since liteline was first installed. Prior
  sessions are not backfilled.
- To inspect or correct the cache: `cat ~/.cache/liteline/costs.json`
- To reset: `rm ~/.cache/liteline/costs.json`

**Rate limits section does not appear**

- Rate limit data (`rate_limits`) was added in Claude Code ≥ 2.1.x. Update
  Claude Code if you are on an older release.

**Compaction counter does not appear after a compaction**

- The counter only appears when `transcript_path` is present in the payload and
  the file is readable. Sandboxed or restricted environments may block filesystem
  access to the transcript.
- A count of `0` is always suppressed — the `⟳` symbol only appears for ≥ 1.

**Colors look wrong or garbled**

- Some terminal emulators or multiplexers (tmux, screen) may strip or misrender
  ANSI codes. Try `TERM=xterm-256color` or check your terminal's color support.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for the full text.

Copyright 2026 William Caban
