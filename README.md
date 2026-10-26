<div align="center">

# 🧠 Ashat Neural Host

**Your own AI server — private, local, yours.**

_A glassy control plane for running GGUF models on your hardware._

[![CI](actions/workflows/ci.yml/badge.svg)](actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-7c6cff.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/Node-20%2B-3ddc84.svg)](https://nodejs.org)
[![Windows](https://img.shields.io/badge/Windows-0078D6.svg)](https://github.com)
[![macOS](https://img.shields.io/badge/macOS-000000.svg)](https://github.com)
[![Linux](https://img.shields.io/badge/Linux-FCC624.svg)](https://github.com)

_Made with ♥ by [AGP Studios, inc](https://www.agpstudios.org)_

</div>

---

## 🚀 Get running in 3 steps

| # | Do this |
|---|---|
| **1️⃣** | **Install two things:** [Node.js 20+](https://nodejs.org) + the engine:<br>Windows (PowerShell): `irm https://mistralrs.dev/install.ps1 \| iex`<br>macOS / Linux: `curl -fsSL https://mistralrs.dev/install.sh \| sh` |
| **2️⃣** | **Drop a model in:** download `LFM2.5-2.6B-QAD-Q4_0.gguf` (~1.5 GB, [link](https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF)) into the `models/` folder. _(Any `.gguf` works — this one is recommended for CPU.)_ |
| **3️⃣** | **Start it:** `npm start` → open **http://localhost:8787** 🎉 |

> First start with an empty folder? ANH creates `config.toml` + `models/` for
> you and pops up a welcome dialog. Drop a `.gguf` in, hit **Restart engine**
> on the dashboard, done. Everything lives in [`config.toml`](config.toml).

---

## ✨ What's inside

- 📊 **Dashboard** — live tok/s chart, uptime, request totals, engine logs, one-click restart/shutdown
- 💬 **Console** — terminal-style chat (`/help` for host commands like `/restart`, `/discord test`, `/key generate`)
- ⚙️ **Settings** — model switcher, ports, AI persona, Discord bot, API keys (General / Persona / Discord / Access tabs)
- 🔌 **OpenAI-compatible API** — point any client at `http://localhost:8787/v1` with model **`ashat`**
- 🤖 **Discord-ready** — optional second engine with its own model, context window & auto-compaction
- 🔒 **Local-only** — loopback bindings, masked secrets, constant-time key checks

```sh
# Talk to it (no key until you generate one on the dashboard):
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"ashat","messages":[{"role":"user","content":"Hello!"}]}'
```

<details>
<summary><b>⚙️ Settings reference</b> (all in <code>config.toml</code>, or use the Settings page)</summary>

| Section | What it does |
|---|---|
| `[host] port` | Website port (restart the Host to apply) |
| `[engine] port/model` | Engine port + active GGUF (Dashboard Restart applies) |
| `[auth] api_key` | `sk-...` gates `/v1/*`, `/api/chat` + all state-changing `/api/*` (generate on dashboard) |
| `[persona]` | Name + system prompt the AI identifies with |
| `[engine.context]` | Context window cap + auto-compaction (`truncate` / `summarize`) |
| `[discord]` | Bot token, **own model** (empty = shares main engine), ports |
| `[discord.context]` | Own window + auto-compaction for the bot's engine |

**Discord engine:** ANH stores + validates the token and optionally boots a
second inference engine for the bot — it is *not* a Discord gateway client
(no message handling). Leave Model empty and the bot shares Ashat's engine;
pick another `.gguf` (or a different context) and the Host boots a second
engine on its own port (never the main port). The dashboard shows the mode.
**Transparent proxy:** `/v1/chat/completions` passes requests through
untouched (incl. `stream: true` SSE + tool-call deltas) — persona injection
and auto-compaction apply only to the Host's own chats, never silently to Pi.
**Auto-compaction:** when history would exceed `context − reserve − reply`,
oldest messages are truncated — or summarized by the engine into a system
note (with truncate fallback).
</details>

<details>
<summary><b>🔒 Security & antivirus</b></summary>

Short version: **there is nothing to find.** Zero binaries, zero dependencies,
zero install scripts — plain-text source you can read end to end.

| Behavior | Why it's safe |
|---|---|
| Listens on `127.0.0.1:8787` + `127.0.0.1:1234` | Loopback only — invisible to your network |
| Spawns / restarts the engine | Normal supervision; only kills PIDs this Host spawned (never by name) |
| PowerShell one-liner on first Windows start | Just the welcome dialog — no downloads, registry, or persistence |
| `ashat.cmd` / `ashat` launchers | 3-line forwarders to the engine binary |

Hardened in the box: constant-time key compare, cross-site browser calls get
`403` unless keyed, path-traversal guard, 5 MB request cap, least-privilege
CI, releases ship code only. The **engine binary itself** (fetched by its own
installer) may trip SmartScreen as unsigned — normal for indie open source;
keep the official installer and check its GitHub release hashes.
</details>

<details>
<summary><b>🧪 Tests & releases</b></summary>

```sh
npm test   # node:test, offline assertions, no engine/model needed
```

Releases are fully GitHub-handled: bump `version` in `package.json`, push to
`main` → CI matrix (Ubuntu/Windows/macOS × Node 20/22) → green build auto-tags
`vX.Y.Z`, packages code-only artifacts, and publishes the Release.
(Manual fallback: Actions → Release (ANH v1) → Run workflow.)
</details>

<details>
<summary><b>🗂️ Project layout</b></summary>

```
config.toml          # YOUR local settings (git-ignored, created on first start)
config.example.toml  # tracked starter copy — copy to config.toml to start manual
host/server.js       # backend (supervises engines, serves UI + /v1)
host/lib.js          # pure logic (TOML, rebrand, persona, compaction) — unit-tested
host/public/         # glassy UI (no build step)
test/                # npm test (offline assertions)
.github/workflows/  # ci.yml (matrix) + release.yml (auto-release)
ashat / ashat.cmd    # engine launcher aliases (sh / Windows)
models/              # your .gguf files (git-ignored, auto-discovered)
```
</details>

---

<div align="center">

© 2026 [AGP Studios, inc](https://www.agpstudios.org) · MIT License · local inference, your hardware, your data.

</div>
