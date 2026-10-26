# Ashat Neural Host (AHN v1)

Self-hosted local-AI control plane. **Three steps, any OS:**

1. Drop a `.gguf` model into [`models/`](models/) — auto-discovered, no config edit.
2. `npm start`
3. Open the website (default http://localhost:8787).

Glassy dashboard (token speed, errors, log tail, restart/shutdown), test chat,
Settings page (model switch, ports, persona, Discord bot, OpenAI API keys),
and an OpenAI-compatible API where the model id is **`ashat`**.

## Requirements

- **Node.js 20+** (any OS — the Host backend is stdlib-only, zero dependencies).
- **Engine binary** (runs the model; the Host supervises it):
  - Windows (PowerShell): `irm https://mistralrs.dev/install.ps1 | iex`
  - macOS / Linux: `curl -fsSL https://mistralrs.dev/install.sh | sh`
- **A model (any GGUF works)**: we recommend `LFM2.5-2.6B-QAD-Q4_0.gguf` (~1.5 GB) from
  [LiquidAI/LFM2.5-2.6B-GGUF](https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF)
  into `models/`. Details in [`models/README.md`](models/README.md).

## Run

```sh
npm start
# → Ashat Neural Host → http://localhost:8787
```

First start with an empty folder: the Host creates `config.toml` (defaults)
and `models/` for you and pops up a dialog asking for a `.gguf` — drop one
in, then press **Restart engine** on the dashboard.

The Host boots the engine automatically (`models/` is scanned, missing
config picks the first GGUF found). Everything is stored in
[`config.toml`](config.toml) — edit it by hand or in **Settings**.

## Use the API

```sh
# open endpoint (until you generate a key on the dashboard):
curl http://localhost:8787/v1/models
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"ashat","messages":[{"role":"user","content":"Hello!"}]}'

# with a key:  -H "Authorization: Bearer sk-..."
```

Raw engine endpoint (no key, id `default`): http://localhost:1234/v1

## Settings (all in `config.toml`)

| Section | What |
|---|---|
| `[host] port` | Website port (restart the Host to apply) |
| `[engine] port/model` | Engine port + active GGUF (Dashboard Restart applies) |
| `[auth] api_key` | `sk-...` gates `/v1/*` (generate on dashboard) |
| `[persona]` | Name + system prompt the AI identifies with |
| `[engine.context]` | Context window cap + auto-compaction (`truncate`/`summarize`) |
| `[discord]` | Bot token, **own model** (empty = shares main engine), ports |
| `[discord.context]` | Own window + auto-compaction for the bot's engine |

## Discord bot engine + context windows

- **Settings → Discord → Model**: leave empty and the bot shares Ashat's
  engine; pick another `.gguf` and the Host boots a **second engine**
  (on `[discord] port`, default 1235) when the bot is enabled with a token.
  The dashboard shows which mode the bot is in (`shares main engine` /
  `own engine online :port`).
- **Context size** (`0` = engine default) caps `--max-model-len` per engine.
- **Auto-compaction** kicks in when a request would exceed
  `context − reserve − reply`: `truncate` drops the oldest history,
  `summarize` asks the engine to compress it into a system note first
  (falls back to truncate if that fails). Ashat's policy applies to
  dashboard chat and `/v1/chat/completions`; the bot's policy is stored
  alongside its engine for the same behavior.

## Tests

```sh
npm test   # node:test, no engine/model needed (offline assertions)
```

## Releases

```sh
git tag v1.0.0 && git push origin v1.0.0
```

CI tests on Ubuntu/Windows/macOS × Node 20/22, then the release workflow
packages code-only artifacts (models are never shipped) onto the GitHub Release.

## Layout

```
config.toml          # THE settings store
host/server.js       # backend (supervises engine, serves UI + /v1)
host/lib.js          # pure logic (TOML, rebrand, persona) — unit-tested
host/public/         # glassy UI (no build step)
host/settings.json   # legacy (auto-migrated once, then ignored)
test/                # npm test
.github/workflows/  # ci.yml (matrix) + release.yml (tags v*)
ashat / ashat.cmd    # engine launcher aliases (sh / Windows)
models/              # your .gguf files (git-ignored, auto-discovered)
```

License: MIT — © 2026 [AGP Studios, inc](https://www.agpstudios.org).
