// Ashat Neural Host — pure logic (no I/O side effects on require).
// Tested with `npm test` (node:test, stdlib only).
'use strict';

function defaultSettings() {
  return {
    hostPort: 8787,
    enginePort: 1234,
    modelFile: 'LFM2.5-2.6B-Q4_0.gguf',
    apiKey: '',
    discord: { enabled: false, token: '', clientId: '', guildId: '', prefix: '!', model: '', port: 1235, context: 0, compactEnabled: false, compactStrategy: 'truncate', compactReserve: 512 },
    engineContext: 0, // 0 = engine default (4096 for LFM2.5); any GGUF works, see Settings
    compactEnabled: false,
    compactStrategy: 'truncate', // truncate | summarize
    compactReserve: 512,
    persona: { name: 'Ashat', systemPrompt: 'You are Ashat, a helpful AI assistant running locally on Ashat Neural Host. Always identify yourself as Ashat.' },
  };
}

// ---- Minimal TOML (subset: [section], key = "str" | number | bool) ----
function tomlParse(text) {
  const out = {};
  let section = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sm = line.match(/^\[([^\]]+)\]$/);
    if (sm) { section = sm[1].trim(); out[section] = out[section] || {}; continue; }
    if (!section) continue;
    const km = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!km) continue;
    let v = km[2];
    let inQ = false; // strip trailing comments outside quotes
    for (let i = 0; i < v.length; i++) {
      if (v[i] === '"' && v[i - 1] !== '\\') inQ = !inQ;
      if (v[i] === '#' && !inQ) { v = v.slice(0, i).trimEnd(); break; }
    }
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      out[section][km[1]] = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (/^(true|false)$/i.test(v)) {
      out[section][km[1]] = /^true$/i.test(v);
    } else if (/^-?\d+$/.test(v)) {
      out[section][km[1]] = parseInt(v, 10);
    }
  }
  return out;
}
function tomlEscape(s) { return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function tomlSerialize(s) {
  const d = s.discord, p = s.persona;
  return `# Ashat Neural Host — THE settings file. Everything lives here.\n# Managed by the Host + Settings page (http://localhost:${s.hostPort}) — safe to edit by hand too.\n#\n# The 3-step workflow:\n#   1. Drop a .gguf model file into ./models   (auto-discovered, no config needed)\n#   2. Start ANH:  npm start\n#   3. Open the website:  http://localhost:${s.hostPort}  (port comes from [host] below)\n#\n# Engine: ashat-engine (Rust, CPU) · OpenAI-compatible model id on :${s.hostPort}/v1 is "ashat"\n\n[host]\nport = ${s.hostPort}            # website + /v1 proxy port (restart the Host to apply)

[engine.context]
size = ${s.engineContext}            # 0 = engine default; caps the context window (--max-model-len)
compact_enabled = ${s.compactEnabled ? 'true' : 'false'}
compact_strategy = "${tomlEscape(s.compactStrategy)}"  # truncate | summarize — what to do when history exceeds the window
compact_reserve = ${s.compactReserve}         # tokens kept free for the reply + safety margin\n\n[engine]\nport = ${s.enginePort}            # engine port (Dashboard Restart applies this)\nmodel = "${tomlEscape(s.modelFile)}"  # active GGUF in ./models (Settings page switches this)\ndevice = "cpu"         # cpu-only for now\n\n[auth]\napi_key = "${tomlEscape(s.apiKey)}"           # empty = open; generate one on the dashboard ("sk-...")\n\n[persona]\nname = "${tomlEscape(p.name)}"          # how the AI identifies itself\nsystem_prompt = "${tomlEscape(p.systemPrompt)}"\n\n[discord]\nenabled = ${d.enabled ? 'true' : 'false'}\ntoken = "${tomlEscape(d.token)}"             # bot token (never shown back — paste to replace)\nclient_id = "${tomlEscape(d.clientId)}"\nguild_id = "${tomlEscape(d.guildId)}"\nprefix = "${tomlEscape(d.prefix)}"\nmodel = "${tomlEscape(d.model)}"            # empty = same as main (shares its engine); else a second engine boots on [discord] port\nport = ${d.port}            # second-engine port (only when discord uses its own model)\n\n[discord.context]\nsize = ${d.context}            # 0 = engine default; own window for the bot's engine\ncompact_enabled = ${d.compactEnabled ? 'true' : 'false'}\ncompact_strategy = "${tomlEscape(d.compactStrategy)}"\ncompact_reserve = ${d.compactReserve}\n`;
}
function settingsFromToml(t) {
  const s = defaultSettings();
  if (t.host && typeof t.host.port === 'number') s.hostPort = t.host.port;
  if (t.engine && typeof t.engine.port === 'number') s.enginePort = t.engine.port;
  if (t.engine && typeof t.engine.model === 'string' && t.engine.model) s.modelFile = t.engine.model;
  if (t.auth && typeof t.auth.api_key === 'string') s.apiKey = t.auth.api_key;
  if (t.persona) {
    if (typeof t.persona.name === 'string' && t.persona.name.trim()) s.persona.name = t.persona.name.trim().slice(0, 40);
    if (typeof t.persona.system_prompt === 'string') s.persona.systemPrompt = t.persona.system_prompt.slice(0, 2000);
  }    if (t.discord) {
      if (typeof t.discord.enabled === 'boolean') s.discord.enabled = t.discord.enabled;
      for (const [tk, sk] of [['token', 'token'], ['client_id', 'clientId'], ['guild_id', 'guildId'], ['prefix', 'prefix'], ['model', 'model']]) {
        if (typeof t.discord[tk] === 'string') s.discord[sk] = t.discord[tk];
      }
      if (typeof t.discord.port === 'number') s.discord.port = t.discord.port;
    }
    if (t.engine && t.engine.context && typeof t.engine.context === 'object') {
      const c = t.engine.context;
      if (typeof c.size === 'number') s.engineContext = c.size;
      if (typeof c.compact_enabled === 'boolean') s.compactEnabled = c.compact_enabled;
      if (c.compact_strategy === 'truncate' || c.compact_strategy === 'summarize') s.compactStrategy = c.compact_strategy;
      if (typeof c.compact_reserve === 'number') s.compactReserve = c.compact_reserve;
    } else if (t['engine.context'] && typeof t['engine.context'] === 'object') {
      const c = t['engine.context'];
      if (typeof c.size === 'number') s.engineContext = c.size;
      if (typeof c.compact_enabled === 'boolean') s.compactEnabled = c.compact_enabled;
      if (c.compact_strategy === 'truncate' || c.compact_strategy === 'summarize') s.compactStrategy = c.compact_strategy;
      if (typeof c.compact_reserve === 'number') s.compactReserve = c.compact_reserve;
    }
    if (t['discord.context'] && typeof t['discord.context'] === 'object') {
      const c = t['discord.context'];
      if (typeof c.size === 'number') s.discord.context = c.size;
      if (typeof c.compact_enabled === 'boolean') s.discord.compactEnabled = c.compact_enabled;
      if (c.compact_strategy === 'truncate' || c.compact_strategy === 'summarize') s.discord.compactStrategy = c.compact_strategy;
      if (typeof c.compact_reserve === 'number') s.discord.compactReserve = c.compact_reserve;
    }
  return s;
}

// ---- Rebrand: the engine underneath is mistral.rs, the Host only speaks Ashat ----
function brand(s) {
  return String(s)
    .replace(/mistralrs_server_core/g, 'ashat_server')
    .replace(/mistralrs_core/g, 'ashat_core')
    .replace(/mistralrs\.exe/gi, 'ashat-engine.exe')
    .replace(/mistralrs\.dev/gi, 'ashat.local')
    .replace(/mistralrs/gi, 'ashat')
    .replace(/mistral\.rs/gi, 'Ashat');
}

// ---- Persona: caller's system message wins, otherwise the Ashat identity ----
function ensurePersona(settings, messages) {
  const msgs = Array.isArray(messages) ? messages.slice() : [];
  if (!msgs.some((m) => m && m.role === 'system') && settings.persona.systemPrompt) {
    msgs.unshift({ role: 'system', content: settings.persona.systemPrompt });
  }
  return msgs;
}

// ---- Context estimation + auto-compaction (pure; summarize injected) ----
// Heuristic, not a tokenizer: plain prose ~3.6 chars/token, code/tool JSON
// (~5%+ symbol chars) is denser at ~3.0. Per-message +4 covers role framing;
// each tool_call block costs ~20 for its JSON scaffolding.
function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 4;
  const symbols = (s.match(/[{}();=<>\/\[\]"':,]/g) || []).length;
  const divisor = symbols > s.length * 0.08 ? 3.0 : 3.6;
  return Math.ceil(s.length / divisor) + 4;
}
function messageText(m) {
  if (!m || !m.content) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join(' ');
  return String(m.content);
}
function messagesTokens(msgs) {
  return msgs.reduce((a, m) => {
    let c = estimateTokens(messageText(m));
    if (m && Array.isArray(m.tool_calls)) c += m.tool_calls.length * 20;
    if (m && m.tool_calls) c += estimateTokens(JSON.stringify(m.tool_calls).slice(0, 8000));
    return a + c;
  }, 0);
}
function compactTruncate(messages, budgetTokens) {
  const sys = messages.filter((m) => m && m.role === 'system');
  const rest = messages.filter((m) => !m || m.role !== 'system');
  const sysCost = messagesTokens(sys);
  const kept = [];
  let cost = sysCost;
  for (let i = rest.length - 1; i >= 0; i--) { // newest first
    const c = estimateTokens(messageText(rest[i]));
    if (kept.length && cost + c > budgetTokens) continue; // drop oldest…
    kept.unshift(rest[i]);
    cost += c;
    if (i === rest.length - 1 && cost > budgetTokens) break; // …but always keep the latest message
  }
  const out = [...sys, ...kept];
  return { messages: out, dropped: messages.length - out.length };
}
async function applyCompaction(messages, { budgetTokens, strategy, summarize }) {
  const msgs = Array.isArray(messages) ? messages.slice() : [];
  if (!msgs.length || strategy === 'off' || messagesTokens(msgs) <= budgetTokens) {
    return { messages: msgs, compacted: false, dropped: 0, note: '' };
  }
  if (strategy === 'summarize' && typeof summarize === 'function') {
    try {
      const { messages: kept, dropped } = compactTruncate(msgs, Math.floor(budgetTokens * 0.7));
      const droppedText = msgs.slice(0, msgs.length - kept.filter((m) => m.role !== 'system').length)
        .filter((m) => m.role !== 'system').map((m) => `${m.role}: ${messageText(m)}`).join('\n').slice(0, 6000);
      const summary = String(await summarize(droppedText)).slice(0, 1500);
      const sys = kept.filter((m) => m.role === 'system');
      const rest = kept.filter((m) => !m || m.role !== 'system');
      return {
        messages: [...sys, { role: 'system', content: `[Earlier conversation summarized to save context]: ${summary}` }, ...rest],
        compacted: true, dropped, note: `summarized ${dropped} older message(s)`,
      };
    } catch { /* fall through to truncate */ }
  }
  const t = compactTruncate(msgs, budgetTokens);
  return { messages: t.messages, compacted: t.dropped > 0, dropped: t.dropped, note: t.dropped ? `dropped ${t.dropped} oldest message(s)` : '' };
}

// ---- First-run bootstrap: never crash on a fresh folder ----
function planFirstRun({ configExists, modelsExists }) {
  const createConfig = !configExists;
  const createModels = !modelsExists;
  return { createConfig, createModels, showDialog: createConfig || createModels };
}
function firstRunMessage(created) {
  return [
    'Ashat Neural Host — first start',
    ...created.map((c) => `Created: ${c}`),
    '',
    'Please place a .gguf model file inside the models folder,',
    'then press Restart engine on the Dashboard (or restart the Host).',
    'Any GGUF works — LFM2.5 Q4_0 is recommended for CPU.',
  ].join('\n');
}
function firstRunPsScript(msg) {
  // Here-string (@'...'@) so quotes/newlines in msg need no escaping.
  return `Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.MessageBox]::Show(@'\n${msg}\n'@, 'Ashat Neural Host') | Out-Null\n`;
}

module.exports = { defaultSettings, tomlParse, tomlEscape, tomlSerialize, settingsFromToml, brand, ensurePersona, estimateTokens, messagesTokens, compactTruncate, applyCompaction, planFirstRun, firstRunMessage, firstRunPsScript };
