// First boot with no config file: the Host writes defaults and keeps serving.
// (No dialog here: test processes aren't TTYs, and CI sets CI=true.)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.ANH_TEST_PORT2 || 8872);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anh-first-'));
const MISSING_CONFIG = path.join(TMP, 'config.toml'); // does not exist yet
let child;

async function waitUp() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/api/status`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('host did not start');
}

describe('first run (no config.toml)', () => {
  before(async () => {
    child = spawn(process.execPath, ['host/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, HOST_PORT: String(PORT), ANH_CONFIG: MISSING_CONFIG },
      stdio: 'ignore',
    });
    await waitUp();
  });
  after(() => { try { child.kill(); } catch {} });

  it('creates a default config.toml and serves from it', async () => {
    assert.ok(fs.existsSync(MISSING_CONFIG), 'config should be created on first boot');
    const raw = fs.readFileSync(MISSING_CONFIG, 'utf8');
    assert.match(raw, /\[host\]/);
    const j = await (await fetch(`${BASE}/api/settings`)).json();
    assert.equal(j.hostPort, 8787); // default written to the fresh file (HOST_PORT env only moves the listener)
  });
});
