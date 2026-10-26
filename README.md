# Ashat Neural Host (ANH v1)

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

## Security & antivirus

Short version: **there is nothing to find.** The repo contains zero
binaries, zero dependencies (`npm install` installs nothing), zero install
scripts, and plain-text source you can read end to end. What the app *does*
that can look noisy to a scanner, and why it's benign:

| Behavior | Why it's safe |
|---|---|
| Listens on `127.0.0.1:8787` (Host) and `127.0.0.1:1234` (engine) | Loopback only — unreachable from your network. The engine is explicitly bound to localhost, not `0.0.0.0`. |
| Spawns the engine, `taskkill`/`pkill` on restart | Normal process supervision; only ever touches processes named `mistralrs`. |
| Runs a PowerShell one-liner on first Windows start | Shows the welcome dialog (add/remove programs style message box). No downloads, no registry, no persistence. |
| `ashat.cmd` / `ashat` launchers | 3-line forwarders to the engine binary. |
| Discord token in `config.toml` | Required to call Discord as your bot; the file is chmodded owner-only on save, tokens are masked in the UI/API, and never logged. |

Hardening already in the box: API keys compared in constant time,
cross-site browser calls to a keyless endpoint get `403` (curl/python unaffected),
path-traversal guard on static files, 5 MB request cap, CI runs least-privilege,
releases ship code only (never weights or secrets).

One honest expectation: the **engine binary itself** (mistral.rs, fetched by
its installer — not from this repo) may be unsigned, so Windows SmartScreen
can ask you to confirm it on first download. That's normal for independent
open-source binaries: keep the official installer, check the release hashes
on GitHub, and you're good.

## Tests

```sh
npm test   # node:test, no engine/model needed (offline assertions)
```

## Releases

No local release script — GitHub handles it end to end:

1. Bump `version` in `package.json`, commit, and push to `main`.
2. CI runs the full matrix (Ubuntu/Windows/macOS × Node 20/22).
3. If green, the Release workflow fires automatically: it tags `vX.Y.Z`,
   packages code-only artifacts (models are never shipped), and publishes
   the GitHub Release. Re-running with an unchanged version is a no-op.

Manual fallback: Actions → Release (ANH v1) → Run workflow. The workflow
also refuses to ship live secrets (the test suite asserts a clean `config.toml`).

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
