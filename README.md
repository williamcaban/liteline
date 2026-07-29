# liteline

A minimal, zero-dependency status line for [Claude Code](https://claude.ai/code).
Shows session cost, context window usage, token counts, API rate limits, and
compaction count — all from data Claude Code already provides. No network calls,
no keychain access, no npm packages to audit.

```
Opus 4.6 (1M context) │ $0.12 │ 42% ctx │ 60k tok │ 4m30s ║ 5h:42% ↺2h15m  7d:15% ↺3d5h ║ ⟳2
```

---

## What it shows

The output is divided into three sections separated by `║`.

### Session (always shown)

| Field | Description |
|---|---|
| Model name | Display name from the Claude Code payload, truncated to 24 chars |
| Cost | Cumulative session cost in USD (`$0.12`, `$0.003`, `<$0.001`) |
| Context % | Percentage of the context window used — green < 60%, yellow < 85%, red ≥ 85% |
| Tokens | Total input + output tokens this session (`60k`, `1.2M`) |
| Duration | Wall-clock session time (`45s`, `4m30s`, `2h5m`) |

### Rate limits (shown when Claude Code reports them)

| Field | Description |
|---|---|
| `5h:42%` | 5-hour rolling usage window — same color scale as context % |
| `↺2h15m` | Time until that window resets |
| `7d:15%` | 7-day rolling usage window |
| `↺3d5h` | Time until the weekly window resets |

Rate limit data appears in Claude Code ≥ 2.1.x. If your version does not include
it, this section is silently omitted.

### Compaction (shown only when > 0)

| Field | Description |
|---|---|
| `⟳2` | Number of context compactions that occurred in this session |

Compaction is counted by scanning the session transcript for
`{type: "system", subtype: "compact_boundary"}` markers that Claude Code writes
on every compaction event. Sidechain (subagent) entries are excluded.

---

## Requirements

- **Node.js ≥ 18** — no install, no build step
- **Claude Code** with `statusLine` support (any version that accepts a `command`
  type status line)

---

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/williamcaban/liteline.git ~/liteline
```

Or place it anywhere you like — the path you choose goes into settings in the
next step.

### 2. Make the script executable

```bash
chmod +x ~/liteline/statusline.js
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

Replace `/absolute/path/to/liteline` with the actual path where you cloned the
repo. Use an absolute path — Claude Code may invoke the command from any working
directory.

`refreshInterval` is in seconds. `10` is a good default; lower values refresh
faster but run the script more often.

### 4. Verify it works

Pipe a test payload and confirm you see formatted output:

```bash
echo '{
  "model": {"display_name": "Opus 4.6 (1M context)"},
  "cost": {"total_cost_usd": 0.123, "total_duration_ms": 270000},
  "context_window": {
    "used_percentage": 42,
    "total_input_tokens": 50000,
    "total_output_tokens": 10000
  },
  "rate_limits": {
    "five_hour":  {"used_percentage": 42, "resets_at": 1774020000},
    "seven_day":  {"used_percentage": 15, "resets_at": 1774540000}
  }
}' | node ~/liteline/statusline.js
```

You should see a single colored line. If you see a Node.js error instead, check
that your Node.js version is ≥ 18 (`node --version`).

---

## Updating

```bash
cd ~/liteline
git pull
```

No rebuild needed — the script runs directly from source.

---

## How it works

Claude Code executes the `command` from `settings.json` every `refreshInterval`
seconds and writes the result to the status bar. It pipes a JSON object
(the `StatusJSON` payload) to the command's stdin. `liteline` reads that payload,
formats it, and prints one line to stdout.

The only exception is the compaction counter: because Claude Code does not include
the compaction count in the payload, `liteline` reads it directly from the session
transcript file whose path Claude Code does include in the payload. The transcript
is streamed line-by-line and only the compact-boundary marker entries are examined —
conversation content is never read or stored.

### Payload fields used

```
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
| No network calls | All data comes from stdin or the local transcript file |
| No keychain access | Does not call `security`, `secret-tool`, or any credential store |
| No shell exec | No `exec`, `execSync`, or child processes spawned |
| No npm dependencies | Zero packages to audit or update |
| Minimal filesystem access | Only reads the session transcript path provided by Claude Code |
| Readable source | Single 155-line script — read it in two minutes |

---

## Troubleshooting

**Status bar is blank or missing**

- Confirm the path in `settings.json` is absolute and the file exists.
- Run the verification command from step 4 above to check for errors.
- Ensure `statusLine.type` is `"command"` (not `"text"`).

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

MIT
