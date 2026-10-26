// Integration tests: boots the real Host on a test port with a temp config.
// Engine-dependent paths are asserted in their *offline* shape (no model,
// no engine binary in CI) — engine chat tests run only with ANH_TEST_ENGINE=1.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.ANH_TEST_PORT || 8871);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anh-test-'));
const TEST_CONFIG = path.join(TMP, 'config.toml');
fs.writeFileSync(TEST_CONFIG, `[host]\nport = ${PORT}\n\n[engine]\nport = 59999\nmodel = "does-not-exist.gguf"\n`);

let child;
let savedKey;
async function waitUp() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('host did not start');
}

before(async () => {
  child = spawn(process.execPath, ['host/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOST_PORT: String(PORT), ANH_CONFIG: TEST_CONFIG },
    stdio: 'ignore',
  });
  await waitUp();
});
after(() => { try { child.kill(); } catch {} });

describe('host API (engine offline)', () => {
  it('serves the Ashat UI', async () => {
    const r = await fetch(`${BASE}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Ashat Neural Host/);
  });

  it('reports engine offline but stays up', async () => {
    const j = await (await fetch(`${BASE}/api/status`)).json();
    assert.equal(j.host, 'Ashat Neural Host');
    assert.equal(j.engine.up, false); // no engine on port 59999
  });

  it('lists models as an array', async () => {
    const j = await (await fetch(`${BASE}/api/models`)).json();
    assert.ok(Array.isArray(j.models));
  });

  it('rejects unknown model selection', async () => {
    const r = await fetch(`${BASE}/api/model/select`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'nope.gguf' }),
    });
    assert.equal(r.status, 400);
  });

  it('round-trips settings through config.toml', async () => {
    const get = async () => (await (await fetch(`${BASE}/api/settings`)).json());
    assert.equal((await get()).discord.prefix, '!');
    const post = await fetch(`${BASE}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discord: { prefix: '?' }, engineContext: 2048, compactEnabled: true, compactStrategy: 'summarize' }),
    });
    assert.equal((await post.json()).ok, true);
    assert.equal((await get()).discord.prefix, '?');
    assert.equal((await get()).engineContext, 2048);
    assert.equal((await get()).compactStrategy, 'summarize');
    // unknown discord models are rejected (stays shared)
    await fetch(`${BASE}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discord: { model: 'nope.gguf' } }),
    });
    assert.equal((await get()).discord.model, '');
    const raw = fs.readFileSync(TEST_CONFIG, 'utf8');
    assert.match(raw, /size = 2048/);
    assert.match(raw, /compact_strategy = "summarize"/);
    assert.match(raw, /prefix = "\?"/);
  });

  it('gates the key-protected OpenAI endpoint, 503s without engine', async () => {
    const key = await (await fetch(`${BASE}/api/key/generate`, { method: 'POST' })).json();
    assert.match(key.apiKey, /^sk-/);
    savedKey = key.apiKey;
    const anon = await fetch(`${BASE}/v1/models`);
    assert.equal(anon.status, 401);
    const authed = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${key.apiKey}` } });
    assert.equal(authed.status, 503); // key ok, engine offline
    const chat = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.apiKey}` },
      body: JSON.stringify({ model: 'ashat', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(chat.status, 503);
  });

  it('rejects malformed JSON with 400, not silent {}', async () => {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${savedKey}` },
      body: '{not json',
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Invalid JSON/);
  });

  it('gates admin endpoints + /api/chat behind the key once set', async () => {
    const anonRestart = await fetch(`${BASE}/api/restart`, { method: 'POST' });
    assert.equal(anonRestart.status, 401);
    const anonChat = await fetch(`${BASE}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(anonChat.status, 401);
    const anonSettings = await fetch(`${BASE}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engineContext: 1024 }),
    });
    assert.equal(anonSettings.status, 401);
    // keyed admin passes auth (shutdown only touches owned PIDs → fast ok:true)
    const keyed = await fetch(`${BASE}/api/shutdown`, {
      method: 'POST', headers: { Authorization: `Bearer ${savedKey}` },
    });
    assert.equal(keyed.status, 200);
    assert.equal((await keyed.json()).ok, true);
  });

  it('blocks cross-site browser requests unless keyed', async () => {
    // A random website's fetch() sends Origin — without the key it gets 403,
    // even though the endpoint is open to curl/python (no Origin header).
    const foreign = await fetch(`${BASE}/v1/models`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    const keyed = await fetch(`${BASE}/v1/models`, {
      headers: { Origin: 'https://evil.example', Authorization: `Bearer ${savedKey}` },
    });
    assert.equal(keyed.status, 503); // key accepted, fails only on the offline engine
    const sameOrigin = await fetch(`${BASE}/api/models`, { headers: { Origin: `http://localhost:${PORT}` } });
    assert.equal(sameOrigin.status, 200);
  });
});
