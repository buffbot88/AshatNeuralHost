// Ashat Neural Host — self-hosted control plane (Node stdlib only, no dependencies).
// Cross-OS: Windows / Linux / macOS. Start with `npm start`, open the website, done.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const lib = require('./lib');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const CONFIG_FILE = process.env.ANH_CONFIG || process.env.AHN_CONFIG || path.join(ROOT, 'config.toml'); // THE settings store
const LEGACY_SETTINGS = path.join(__dirname, 'settings.json'); // migrated once, then ignored
const MODELS_DIR = path.join(ROOT, 'models');

function loadSettings() {
  const s = lib.defaultSettings();
  // one-time migration from the old host/settings.json
  try {
    if (fs.existsSync(LEGACY_SETTINGS)) {
      const old = JSON.parse(fs.readFileSync(LEGACY_SETTINGS, 'utf8'));
      if (typeof old.mistralPort === 'number') s.enginePort = old.mistralPort; // legacy key
      if (typeof old.modelFile === 'string') s.modelFile = old.modelFile;
      if (typeof old.apiKey === 'string') s.apiKey = old.apiKey;
      if (old.discord && typeof old.discord === 'object') Object.assign(s.discord, old.discord);
      fs.renameSync(LEGACY_SETTINGS, LEGACY_SETTINGS + '.migrated');
    }
  } catch {}
  try {
    Object.assign(s, lib.settingsFromToml(lib.tomlParse(fs.readFileSync(CONFIG_FILE, 'utf8'))));
  } catch {}
  return s;
}
let settings = loadSettings();
function saveSettings() {
  fs.writeFileSync(CONFIG_FILE, lib.tomlSerialize(settings));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {} // token lives here — owner-only, best effort
}

const state = {
  mistralProc: null,
  mistralPid: null,
  mistralOwned: false, // true only when THIS host spawned the engine
  mistralUp: null, // cached engine health (set by /api/status + startup)
  discord: { proc: null, pid: null, startedAt: null, up: null }, // second engine for the bot (only when it needs its own model)
  startedAt: null,
  logs: [],       // last 300 lines
  errors: [],     // {t, msg} last 50
  samples: [],    // {t, tps} last 60
  stats: { requests: 0, totalTokens: 0, lastTps: 0, avgTps: 0 },
};

function pushLog(line) {
  line = lib.brand(line.trimEnd());
  if (!line) return;
  // Collapse the giant GGUF chat-template dump into one quiet line — it is
  // normal startup noise, never an error (it contains the word
  // "raise_exception" inside template source, which must not trip detection).
  if (line.includes('Discovered and using GGUF chat template')) {
    line = line.split('`')[0].trimEnd() + ' `<template suppressed — normal startup>`';
  }
  // Drop routine per-request chatter: the dashboard health-polls /v1/models
  // every few seconds, and each poll emits started/completed lines. They
  // carry no signal at status=200, so don't store them at all. Failed
  // requests (non-2xx) fall through and are stored + flagged below.
  if (/request (started|completed)/.test(line) && !/status=([45]\d\d)\b/.test(line)) {
    return;
  }
  // No Hugging Face account is used (local GGUF needs none) — hide the
  // harmless "could not load HF token" startup notices.
  if (/huggingface.*token|using no .*token|token source/i.test(line)) {
    return;
  }
  state.logs.push({ t: new Date().toISOString(), line: line.slice(0, 500) });
  if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
  // Only real failure signals become errors: ERROR/WARN log levels or HTTP
  // 4xx/5xx request completions. INFO lines are never errors, even if the
  // message body contains words like "exception" (e.g. template source).
  if (/\s(ERROR|WARN)\s/.test(line) || /status=([45]\d\d)\b/.test(line)) {
    state.errors.unshift({ t: new Date().toISOString(), msg: line.slice(0, 300) });
    if (state.errors.length > 50) state.errors.length = 50;
  }
}
function pushError(msg) {
  state.errors.unshift({ t: new Date().toISOString(), msg: String(msg).slice(0, 300) });
  if (state.errors.length > 50) state.errors.length = 50;
}
function recordCompletion(usage) {
  if (!usage) return;
  const tps = usage.avg_tok_per_sec ?? usage.avg_compl_tok_per_sec ?? 0;
  const total = usage.total_tokens ?? 0;
  state.stats.requests++;
  state.stats.totalTokens += total;
  if (tps > 0) {
    state.stats.lastTps = Math.round(tps * 100) / 100;
    state.samples.push({ t: Date.now(), tps: state.stats.lastTps });
    if (state.samples.length > 60) state.samples.shift();
    const avg = state.samples.reduce((a, s) => a + s.tps, 0) / state.samples.length;
    state.stats.avgTps = Math.round(avg * 100) / 100;
  }
}

function mistralBase() { return `http://127.0.0.1:${settings.enginePort}`; }

async function mistralUp() {
  try {
    const r = await fetch(`${mistralBase()}/v1/models`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

// Cross-OS engine launcher: the mistralrs binary on PATH on every OS
// (installed per README). ashat.cmd / ashat are human aliases — the Host
// spawns the binary directly because cmd/sh wrapper layers break quoting.
function engineLauncher() {
  return 'mistralrs';
}

function killProc(p) {
  if (!p || p.killed || p.exitCode !== null) return;
  const pid = p.pid;
  try { p.kill('SIGTERM'); } catch {}
  // Windows: taskkill the exact PID tree we own — never by image name.
  if (process.platform === 'win32' && pid) {
    exec(`taskkill /PID ${pid} /T /F 2>nul`, () => {});
  }
  setTimeout(() => { try { if (!p.killed && p.exitCode === null) p.kill('SIGKILL'); } catch {} }, 3000);
}
function killMistral() {
  return new Promise((resolve) => {
    // Only ever terminate processes THIS host spawned (tracked handles).
    // Never sweep by binary name — other inference processes are not ours.
    killProc(state.mistralProc);
    killProc(state.discord.proc);
    state.discord.proc = null; state.discord.pid = null; state.discord.up = null;
    state.mistralProc = null; state.mistralPid = null;
    state.mistralOwned = false;
    setTimeout(resolve, 2000);
  });
}

function listModels() {
  // Fresh readdir on EVERY call = auto-discovery: drop a .gguf in ./models
  // and it shows up with no restart and no config edit.
  try {
    if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
    return fs.readdirSync(MODELS_DIR).filter((f) => f.toLowerCase().endsWith('.gguf')).sort();
  } catch { return []; }
}
// Log arrivals/removals so the dashboard log tail tells the story.
try {
  fs.watch(MODELS_DIR, (event, file) => {
    if (!file || !String(file).toLowerCase().endsWith('.gguf')) return;
    const here = listModels().includes(String(file));
    pushLog(here ? `new model discovered: ${file} (pick it in Settings)` : `model removed: ${file}`);
  });
} catch {}
function pickModelFile() {
  // Use the configured model if present; otherwise auto-pick the first
  // discovered GGUF so "drop file + start" just works. Persists to config.toml.
  const found = listModels();
  if (found.includes(settings.modelFile)) return settings.modelFile;
  if (found.length) {
    settings.modelFile = found[0];
    try { saveSettings(); } catch {}
    pushLog(`configured model missing — auto-picked ${found[0]}`);
    return found[0];
  }
  return null;
}

async function startMistral() {
  await killMistral();
  if (await mistralUp()) {
    pushError(`port ${settings.enginePort} is still in use by a process ANH did not start — free it or change [engine] port, then Restart`);
    return false;
  }
  const picked = pickModelFile();
  if (!picked) {
    pushError('No .gguf models in ./models — drop one in and hit Restart');
    return false;
  }
  const modelPath = path.join(MODELS_DIR, picked);
  const args = ['serve', '-f', modelPath, '--cpu', '--host', '127.0.0.1', '--port', String(settings.enginePort),
    ...(settings.engineContext > 0 ? ['--max-model-len', String(settings.engineContext)] : [])];
  pushLog(`$ ashat ${args.join(' ')}`);
  // RUST_LOG=warn keeps the engine's own console quiet (no per-request INFO
  // spam); real warnings and errors still come through and are captured below.
  const proc = spawn(engineLauncher(), args, {
    shell: false, windowsHide: true,
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG || 'warn' },
  });
  state.mistralProc = proc;
  state.mistralOwned = true;
  state.mistralPid = proc.pid ?? null;
  state.startedAt = new Date().toISOString();
  proc.stdout.on('data', (d) => String(d).split('\n').forEach(pushLog));
  proc.stderr.on('data', (d) => String(d).split('\n').forEach(pushLog));
  proc.on('error', (e) => pushError(`ashat engine failed to start: ${e.message}`));
  proc.on('exit', (code) => pushLog(`ashat engine exited (code ${code})`));
  // wait for readiness up to ~120s (model load takes ~10s)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await mistralUp()) {
      state.mistralUp = true; pushLog('ashat engine ready');
      await ensureDiscordEngine(); // bot engine follows main on every (re)start
      return true;
    }
  }
  state.mistralUp = false;
  pushError('ashat engine did not become ready in time (check logs)');
  return false;
}

// Auto-compaction for Ashat's own chats: when the estimated prompt would
// blow past (context − reserve − reply), truncate or summarize history.
async function applyMainPolicy(body) {
  if (!settings.compactEnabled) return body.messages;
  const budget = (settings.engineContext || 4096) - (settings.compactReserve || 0) - (body.max_tokens || 512);
  const res = await lib.applyCompaction(body.messages, {
    budgetTokens: Math.max(budget, 256),
    strategy: settings.compactStrategy,
    summarize: async (text) => {
      const r = await fetch(`${mistralBase()}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'default', messages: [
          { role: 'system', content: 'Summarize the following conversation history in under 150 words, preserving key facts, decisions and user preferences. Reply with only the summary.' },
          { role: 'user', content: text },
        ], max_tokens: 300, temperature: 0.3 }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error('summarizer failed');
      return j.choices?.[0]?.message?.content || '';
    },
  });
  if (res.compacted) pushLog(`context auto-compacted (${res.note})`);
  return res.messages;
}

// ---- Discord's engine: shares main when the bot uses the same model +
// context, otherwise boots a second engine on the discord port. Starts only
// when the bot is enabled with a token saved (it has no one to talk to yet).
function discordNeedsOwnEngine() {
  const d = settings.discord;
  if (!d.enabled || !d.token) return false;
  const dm = d.model || '';
  if (!dm || dm === settings.modelFile) {
    return (d.context || 0) !== (settings.engineContext || 0);
  }
  if (!listModels().includes(dm)) { pushError(`discord model not found: ${dm} — bot shares main engine`); return false; }
  return true;
}
async function startDiscordEngine() {
  const d = settings.discord;
  const modelFile = d.model || settings.modelFile;
  const port = discordOwnPort();
  const maxLen = d.context || 0;
  const modelPath = path.join(MODELS_DIR, modelFile);
  const args = ['serve', '-f', modelPath, '--cpu', '--host', '127.0.0.1', '--port', String(port),
    ...(maxLen > 0 ? ['--max-model-len', String(maxLen)] : [])];
  pushLog(`$ ashat (discord) ${args.join(' ')}`);
  const proc = spawn(engineLauncher(), args, {
    shell: false, windowsHide: true,
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG || 'warn' },
  });
  state.discord.proc = proc;
  state.discord.pid = proc.pid ?? null;
  state.discord.startedAt = new Date().toISOString();
  proc.stdout.on('data', (x) => String(x).split('\n').forEach(pushLog));
  proc.stderr.on('data', (x) => String(x).split('\n').forEach(pushLog));
  proc.on('error', (e) => pushError(`discord engine failed to start: ${e.message}`));
  proc.on('exit', (code) => pushLog(`discord engine exited (code ${code})`));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try { const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) }); if (r.ok) break; } catch {}
  }
  try {
    const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
    state.discord.up = r.ok;
    if (r.ok) pushLog('discord engine ready');
    else pushError('discord engine did not become ready (check logs)');
    return r.ok;
  } catch { state.discord.up = false; pushError('discord engine did not become ready (check logs)'); return false; }
}
function discordEngineStatus() {
  const d = settings.discord;
  const shared = !discordNeedsOwnEngine() && d.enabled && !!d.token;
  const own = !!(!shared && state.discord.proc && !state.discord.proc.killed);
  return {
    wanted: d.enabled && !!d.token,
    shared,
    up: shared ? state.mistralUp : (own ? state.discord.up : false),
    port: shared ? settings.enginePort : discordOwnPort(),
    model: d.model || settings.modelFile,
    context: d.context || settings.engineContext || 4096,
    compact: { enabled: d.compactEnabled, strategy: d.compactStrategy, reserve: d.compactReserve },
    pid: state.discord.pid, startedAt: state.discord.startedAt,
  };
}
async function ensureDiscordEngine() {
  const alive = state.discord.proc && !state.discord.proc.killed;
  if (!discordNeedsOwnEngine()) {
    if (alive) { try { state.discord.proc.kill(); } catch {} }
    state.discord.proc = null; state.discord.pid = null; state.discord.up = null;
    return true;
  }
  if (alive) return true;
  return startDiscordEngine();
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 5e6) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!b) return resolve({});
      try { resolve(JSON.parse(b)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
async function readJsonBody(req, res) {
  try { return await readBody(req); }
  catch (e) { sendJson(res, 400, { error: e.message || 'Invalid JSON' }); return null; }
}
function requireAdmin(req) {
  // State-changing host endpoints need the inference key once one exists.
  // Open installs (no key) stay frictionless; keyed installs are admin-gated.
  if (!settings.apiKey) return true;
  return keyValid(req);
}
function discordOwnPort() {
  // A second engine can never share the main port — force a distinct one.
  const want = settings.discord.port || (settings.enginePort === 1235 ? 1236 : 1235);
  if (want !== settings.enginePort) return want;
  let p = want + 1;
  if (p > 65535) p = 1024;
  if (p === settings.enginePort) p++;
  return p;
}
async function proxyStream(upstreamRes, clientRes) {
  // Transparent SSE passthrough: preserves tool-call deltas + finish reasons.
  clientRes.writeHead(upstreamRes.status, {
    'Content-Type': upstreamRes.headers.get('content-type') || 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  state.stats.requests++;
  try {
    const { Readable } = require('stream');
    await new Promise((resolve, reject) => {
      const nodeStream = Readable.fromWeb(upstreamRes.body);
      nodeStream.on('error', reject);
      clientRes.on('close', () => { try { nodeStream.destroy(); } catch {} resolve(); });
      nodeStream.pipe(clientRes);
      nodeStream.on('end', resolve);
    });
  } catch (e) { try { clientRes.end(); } catch {} }
}
function keyValid(req) {
  // Constant-time compare: the key check must not leak via timing.
  if (!settings.apiKey) return false;
  const h = Buffer.from(req.headers.authorization || '');
  const want = Buffer.from(`Bearer ${settings.apiKey}`);
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
function checkKey(req) {
  if (!settings.apiKey) return true; // open until a key is generated
  return keyValid(req);
}
function browserOriginAllowed(req) {
  // A malicious website can fetch() localhost from the user's browser.
  // Non-browser clients (curl, python, same-origin UI) send no Origin.
  // Foreign-Origin browser calls are honored only with a valid API key.
  const o = req.headers.origin;
  if (!o) return true;
  return o === `http://localhost:${HOST_PORT}` || o === `http://127.0.0.1:${HOST_PORT}`;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ---- CORS for local dev ----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (!browserOriginAllowed(req) && !keyValid(req)) {
      return sendJson(res, 403, { error: 'Cross-origin browser requests are blocked; call this API server-side or from the Ashat dashboard.' });
    }

  try {
    // ---- OpenAI-compatible endpoint, branded as Ashat (key-protected once a key exists) ----
    // The engine underneath is mistral.rs, but clients of THIS port only ever
    // see the model id "ashat". Both "ashat" and legacy "default" are accepted.
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      if (!checkKey(req)) return sendJson(res, 401, { error: 'Invalid API key' });
      if (!(await mistralUp())) return sendJson(res, 503, { error: 'Engine offline' });
      state.mistralUp = true;
      return sendJson(res, 200, {
        object: 'list',
        data: [{ id: 'ashat', object: 'model', created: Date.now(), owned_by: 'ashat', root: 'ashat' }],
      });
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (!checkKey(req)) return sendJson(res, 401, { error: 'Invalid API key' });
      const body = await readJsonBody(req, res);
      if (!body) return;
      if (!(await mistralUp())) return sendJson(res, 503, { error: 'Engine offline' });
      if (!Array.isArray(body.messages)) return sendJson(res, 400, { error: 'messages must be an array' });
      const wantModel = body.model || 'ashat';
      const r = await fetch(`${mistralBase()}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model: 'default', messages: lib.ensurePersona(settings, await applyMainPolicy({ ...body, messages: body.messages })) }),
      });
      if (body.stream) {
        if (!r.ok) {
          let j = {}; try { j = await r.json(); } catch {}
          pushError(`chat completions ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
          return sendJson(res, r.status, j && j.error ? j : { error: 'Engine error' });
        }
        return proxyStream(r, res);
      }
      const j = await r.json();
      if (r.ok) { recordCompletion(j.usage); j.model = wantModel; }
      else pushError(`chat completions ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      return sendJson(res, r.status, j);
    }

    // ---- Host API ----
    if (url.pathname === '/api/status') {
      const up = await mistralUp();
      state.mistralUp = up; // cached so /api/metrics doesn't re-hit the engine
      const mu = process.memoryUsage();
      return sendJson(res, 200, {
        host: 'Ashat Neural Host',
        hostMem: { rss: mu.rss, heapUsed: mu.heapUsed, free: os.freemem(), total: os.totalmem(), load1: os.loadavg()[0] },
        engine: { up, port: settings.enginePort, pid: state.mistralPid, startedAt: state.startedAt, model: settings.modelFile, modelId: 'ashat', context: settings.engineContext || 4096,
          compact: { enabled: settings.compactEnabled, strategy: settings.compactStrategy, reserve: settings.compactReserve } },
        discordEngine: discordEngineStatus(),
        stats: state.stats,
      });
    }
    if (url.pathname === '/api/metrics') {
      return sendJson(res, 200, { up: state.mistralUp, samples: state.samples, errors: state.errors.slice(0, 20), logs: state.logs.slice(-80), stats: state.stats });
    }
    if (url.pathname === '/api/models') {
      // Any GGUF works (engine auto-detects architecture) — LFM2.5 Q4_0 recommended for CPU.
      const models = listModels();
      const sizes = {};
      for (const f of models) {
        try { sizes[f] = fs.statSync(path.join(MODELS_DIR, f)).size; } catch {}
      }
      return sendJson(res, 200, { models, current: settings.modelFile, sizes });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      if (!checkKey(req)) return sendJson(res, 401, { error: 'Invalid API key — save it in this browser (Settings → Access) or revoke it.' });
      const body = await readJsonBody(req, res);
      if (!body) return;
      if (!(await mistralUp())) return sendJson(res, 503, { error: 'Engine offline' });
      if (body.messages !== undefined && !Array.isArray(body.messages)) return sendJson(res, 400, { error: 'messages must be an array' });
      const r = await fetch(`${mistralBase()}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'default', temperature: 0.7, max_tokens: 512, ...body, messages: lib.ensurePersona(settings, await applyMainPolicy({ max_tokens: 512, ...body, messages: body.messages })) }),
      });
      if (body.stream) {
        if (!r.ok) {
          let j = {}; try { j = await r.json(); } catch {}
          return sendJson(res, r.status, j && j.error ? j : { error: 'Engine error' });
        }
        return proxyStream(r, res);
      }
      const j = await r.json();
      if (r.ok) recordCompletion(j.usage);
      else pushError(`chat ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      return sendJson(res, r.status, j);
    }
    if (url.pathname === '/api/restart' && req.method === 'POST') {
      if (!requireAdmin(req)) return sendJson(res, 401, { error: 'Admin key required' });
      pushLog('restart requested');
      const ok = await startMistral();
      return sendJson(res, 200, { ok });
    }
    if (url.pathname === '/api/shutdown' && req.method === 'POST') {
      if (!requireAdmin(req)) return sendJson(res, 401, { error: 'Admin key required' });
      pushLog('shutdown requested');
      await killMistral();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/model/select' && req.method === 'POST') {
      if (!requireAdmin(req)) return sendJson(res, 401, { error: 'Admin key required' });
      const parsed = await readJsonBody(req, res);
      if (!parsed) return;
      const { file } = parsed;
      if (!file || !listModels().includes(file)) return sendJson(res, 400, { error: 'Unknown model file' });
      settings.modelFile = file; saveSettings();
      pushLog(`model switched to ${file} — restarting`);
      const ok = await startMistral();
      return sendJson(res, 200, { ok, current: file });
    }
    if (url.pathname === '/api/settings' && req.method === 'GET') {
      const { apiKey, discord, ...rest } = settings;
      return sendJson(res, 200, {
        ...rest,
        apiKeySet: !!apiKey,
        apiKeyPreview: apiKey ? `sk-...${apiKey.slice(-4)}` : '',
        discord: { ...discord, token: discord.token ? `...${discord.token.slice(-4)}` : '' },
      });
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      if (!requireAdmin(req)) return sendJson(res, 401, { error: 'Admin key required' });
      const b = await readJsonBody(req, res);
      if (!b) return;
      if (typeof b.enginePort === 'number' && b.enginePort > 0 && b.enginePort < 65536) settings.enginePort = b.enginePort;
      else if (typeof b.mistralPort === 'number' && b.mistralPort > 0 && b.mistralPort < 65536) settings.enginePort = b.mistralPort; // legacy key
      let hostRestart = false;
      if (typeof b.hostPort === 'number' && b.hostPort > 0 && b.hostPort < 65536 && b.hostPort !== settings.hostPort) {
        settings.hostPort = b.hostPort; hostRestart = true;
      }
      if (b.discord && typeof b.discord === 'object') {
        for (const k of ['enabled', 'clientId', 'guildId', 'prefix']) settings.discord[k] = b.discord[k] ?? settings.discord[k];
        if (typeof b.discord.model === 'string' && (b.discord.model === '' || listModels().includes(b.discord.model))) settings.discord.model = b.discord.model;
        if (typeof b.discord.port === 'number' && b.discord.port > 0 && b.discord.port < 65536) settings.discord.port = b.discord.port;
        if (typeof b.discord.context === 'number' && b.discord.context >= 0) settings.discord.context = Math.floor(b.discord.context);
        if (typeof b.discord.compactEnabled === 'boolean') settings.discord.compactEnabled = b.discord.compactEnabled;
        if (b.discord.compactStrategy === 'truncate' || b.discord.compactStrategy === 'summarize') settings.discord.compactStrategy = b.discord.compactStrategy;
        if (typeof b.discord.compactReserve === 'number' && b.discord.compactReserve >= 0) settings.discord.compactReserve = Math.floor(b.discord.compactReserve);
        if (typeof b.discord.token === 'string' && b.discord.token && !b.discord.token.includes('...')) {
          settings.discord.token = b.discord.token; // only overwrite with a real new token
        }
        if (b.discord.token === '') settings.discord.token = '';
      }
      if (typeof b.engineContext === 'number' && b.engineContext >= 0 && b.engineContext <= 1000000) settings.engineContext = Math.floor(b.engineContext);
      if (typeof b.compactEnabled === 'boolean') settings.compactEnabled = b.compactEnabled;
      if (b.compactStrategy === 'truncate' || b.compactStrategy === 'summarize') settings.compactStrategy = b.compactStrategy;
      if (typeof b.compactReserve === 'number' && b.compactReserve >= 0) settings.compactReserve = Math.floor(b.compactReserve);
      if (b.persona && typeof b.persona === 'object') {
        if (typeof b.persona.name === 'string' && b.persona.name.trim()) settings.persona.name = b.persona.name.trim().slice(0, 40);
        if (typeof b.persona.systemPrompt === 'string') settings.persona.systemPrompt = b.persona.systemPrompt.slice(0, 2000);
      }
      saveSettings();
      return sendJson(res, 200, { ok: true, hostRestart });
    }
    if (url.pathname === '/api/key/generate' && req.method === 'POST') {
      if (!requireAdmin(req)) return sendJson(res, 401, { error: 'Admin key required — send the current key to rotate' });
      settings.apiKey = 'sk-' + crypto.randomBytes(24).toString('hex');
      saveSettings();
      pushLog('new OpenAI API key generated');
      return sendJson(res, 200, { apiKey: settings.apiKey, note: 'Copy now — it will only be shown once. Use as: Authorization: Bearer <key>' });
    }
    if (url.pathname === '/api/key/revoke' && req.method === 'POST') {
      if (!requireAdmin(req)) return sendJson(res, 401, { error: 'Admin key required' });
      settings.apiKey = ''; saveSettings();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/discord/test' && req.method === 'POST') {
      if (!requireAdmin(req)) return sendJson(res, 401, { error: 'Admin key required' });
      if (!settings.discord.token) return sendJson(res, 400, { error: 'No Discord bot token saved' });
      try {
        const r = await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bot ${settings.discord.token}` },
        });
        const j = await r.json();
        if (!r.ok) { pushError(`discord test ${r.status}: ${JSON.stringify(j).slice(0, 200)}`); return sendJson(res, r.status, { error: j.message || 'Discord rejected the token' }); }
        return sendJson(res, 200, { ok: true, bot: { username: j.username, id: j.id } });
      } catch (e) { pushError(`discord test failed: ${e.message}`); return sendJson(res, 502, { error: e.message }); }
    }

    // ---- Static UI ----
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const fp = path.normalize(path.join(PUBLIC, p));
    if (!fp.startsWith(PUBLIC + path.sep) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      return sendJson(res, 404, { error: 'Not found' });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    pushError(e.message);
    sendJson(res, 500, { error: e.message });
  }
});

// Single-quote a string for sh (macOS/Linux dialog commands).
function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
// First start with an empty folder: create config.toml + models/, then pop
// an OS dialog telling the user to drop a .gguf in before starting.
function ensureFirstRun() {
  const plan = lib.planFirstRun({ configExists: fs.existsSync(CONFIG_FILE), modelsExists: fs.existsSync(MODELS_DIR) });
  const created = [];
  if (plan.createConfig) { try { saveSettings(); created.push('config.toml (default settings)'); } catch (e) { pushError(`could not write config.toml: ${e.message}`); } }
  if (plan.createModels) { try { fs.mkdirSync(MODELS_DIR, { recursive: true }); created.push('models/ folder'); } catch (e) { pushError(`could not create models folder: ${e.message}`); } }
  if (!plan.showDialog) return;
  const msg = lib.firstRunMessage(created.length ? created : ['config.toml', 'models/']);
  console.log(msg);
  pushLog('first run — created ' + created.join(', ') + '; waiting for a .gguf in models/');
  // Headless environments (CI, tests, services) get the log line only —
  // a modal dialog there would block forever with nobody to dismiss it.
  if (process.env.CI || process.env.ANH_NO_DIALOG || process.env.AHN_NO_DIALOG || !process.stdout.isTTY) return;
  try {
    if (process.platform === 'win32') {
      const ps1 = path.join(os.tmpdir(), 'anh-first-run.ps1');
      fs.writeFileSync(ps1, lib.firstRunPsScript(msg));
      exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${ps1}"`, () => {});
    } else if (process.platform === 'darwin') {
      exec('osascript -e ' + shQuote(`display dialog "${msg}" buttons {"OK"} default button "OK" with title "Ashat Neural Host"`), () => {});
    } else {
      exec(`zenity --info --title='Ashat Neural Host' --text=${shQuote(msg)} 2>/dev/null || notify-send 'Ashat Neural Host' 'First start — drop a .gguf into models/' 2>/dev/null || true`, () => {});
    }
  } catch {}
}

const HOST_PORT = process.env.HOST_PORT ? Number(process.env.HOST_PORT) : settings.hostPort;
server.listen(HOST_PORT, '127.0.0.1', async () => {
  console.log(`Ashat Neural Host → http://localhost:${HOST_PORT}`);
  ensureFirstRun();
  if (!(await mistralUp())) {
    console.log('ashat engine not detected — starting it...');
    startMistral();
  } else {
    state.mistralOwned = false; // someone else owns this listener — never kill it
    console.log('ashat engine already running — attached (not owned, will not auto-kill)');
    pushLog('host attached to existing ashat engine (not owned — Restart will refuse while it holds the port)');
  }
});
