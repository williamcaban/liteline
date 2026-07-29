# cc-statusline

Minimal Claude Code status line. Reads the `StatusJSON` payload from stdin and
prints one formatted line — model, session cost, context %, token count, duration.

**No external dependencies. No keychain access. No network calls. No transcript reads.**

## What it shows

```
Opus 4.6 (1M context) │ $0.12 │ 8% ctx │ 61k tok │ 4m30s
```

- **Model** — display name from the payload
- **Cost** — cumulative session USD cost
- **Context %** — turns red >85%, yellow >60%
- **Tokens** — total input + output this session
- **Duration** — wall-clock session time

## Setup

### 1. Make the script executable

```bash
chmod +x /path/to/cc-statusline/statusline.js
```

### 2. Wire into Claude Code settings

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/cc-statusline/statusline.js",
    "padding": 0,
    "refreshInterval": 10
  }
}
```

Replace `/path/to/cc-statusline` with the actual path.

### 3. Verify it works

```bash
echo '{"model":{"display_name":"Opus 4.6 (1M context)"},"cost":{"total_cost_usd":0.123,"total_duration_ms":270000},"context_window":{"used_percentage":42,"total_input_tokens":50000,"total_output_tokens":10000}}' \
  | node statusline.js
```

## Security properties

- Reads only the JSON payload piped by Claude Code (stdin)
- No network calls
- No filesystem reads beyond argv[0]
- No keychain access
- No shell exec
- No npm dependencies
