// Unit tests: TOML store, rebrand filter, persona injection. No engine needed.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../host/lib');

describe('config.toml store (TOML subset)', () => {
  it('round-trips all settings incl. persona and discord', () => {
    const s = lib.defaultSettings();
    s.hostPort = 9999; s.enginePort = 4321; s.modelFile = 'custom.Q4_0.gguf';
    s.apiKey = 'sk-abc123'; s.discord.enabled = true; s.discord.prefix = '?';
    s.persona.name = 'Ashat'; s.persona.systemPrompt = 'Be "great" \\ bold # hashtag';
    const back = lib.settingsFromToml(lib.tomlParse(lib.tomlSerialize(s)));
    assert.equal(back.hostPort, 9999);
    assert.equal(back.enginePort, 4321);
    assert.equal(back.modelFile, 'custom.Q4_0.gguf');
    assert.equal(back.apiKey, 'sk-abc123');
    assert.equal(back.discord.enabled, true);
    assert.equal(back.discord.prefix, '?');
    assert.equal(back.persona.name, 'Ashat');
    assert.equal(back.persona.systemPrompt, 'Be "great" \\ bold # hashtag');
  });

  it('ignores comments, blank lines and unknown sections', () => {
    const t = lib.tomlParse('# hi\n\n[host]\nport = 8787 # site\n[nope]\nx = 1\n');
    assert.equal(t.host.port, 8787);
    assert.equal(t.nope.x, 1);
  });

  it('falls back to defaults on garbage', () => {
    const s = lib.settingsFromToml(lib.tomlParse('not toml at all\n[unclosed'));
    assert.equal(s.hostPort, 8787);
    assert.equal(s.persona.name, 'Ashat');
  });
});

describe('auto-compaction', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a'.repeat(400) },
    { role: 'assistant', content: 'b'.repeat(400) },
    { role: 'user', content: 'c'.repeat(400) },
  ];
  it('passes through when under budget', async () => {
    const r = await lib.applyCompaction(msgs, { budgetTokens: 10000, strategy: 'truncate' });
    assert.equal(r.compacted, false);
    assert.equal(r.messages.length, msgs.length);
  });
  it('truncate keeps system + newest within budget', async () => {
    const r = await lib.applyCompaction(msgs, { budgetTokens: 220, strategy: 'truncate' });
    assert.equal(r.compacted, true);
    assert.equal(r.dropped, 1);
    assert.equal(r.messages[0].role, 'system');
    assert.equal(r.messages[r.messages.length - 1].content, 'c'.repeat(400));
  });
  it('off strategy never compacts', async () => {
    const r = await lib.applyCompaction(msgs, { budgetTokens: 10, strategy: 'off' });
    assert.equal(r.compacted, false);
    assert.equal(r.messages.length, msgs.length);
  });
  it('summarize inserts a summary note, falls back to truncate on failure', async () => {
    const ok = await lib.applyCompaction(msgs, { budgetTokens: 220, strategy: 'summarize', summarize: async () => 'SUMMARY' });
    assert.equal(ok.compacted, true);
    assert.ok(ok.messages.some((m) => m.role === 'system' && String(m.content).includes('SUMMARY')));
    const bad = await lib.applyCompaction(msgs, { budgetTokens: 220, strategy: 'summarize', summarize: async () => { throw new Error('down'); } });
    assert.equal(bad.compacted, true);
    assert.ok(!bad.messages.some((m) => String(m.content || '').includes('SUMMARY')));
  });
});

describe('first-run bootstrap', () => {
  it('creates + notifies only for what is missing', () => {
    assert.deepEqual(lib.planFirstRun({ configExists: false, modelsExists: false }), { createConfig: true, createModels: true, showDialog: true });
    assert.deepEqual(lib.planFirstRun({ configExists: true, modelsExists: true }), { createConfig: false, createModels: false, showDialog: false });
    assert.deepEqual(lib.planFirstRun({ configExists: true, modelsExists: false }), { createConfig: false, createModels: true, showDialog: true });
  });
  it('message tells the user to drop a .gguf in', () => {
    const m = lib.firstRunMessage(['config.toml (default settings)', 'models/ folder']);
    assert.match(m, /Ashat Neural Host/);
    assert.match(m, /\.gguf/);
    assert.match(m, /Restart engine/);
  });
  it('powershell script uses a here-string with the Ashat title', () => {
    const ps = lib.firstRunPsScript('hello');
    assert.match(ps, /System\.Windows\.Forms/);
    assert.match(ps, /@'/);
    assert.match(ps, /Ashat Neural Host/);
  });
});

describe('rebrand filter', () => {
  it('leaves zero mistral*/mistral.rs traces (case-insensitive)', () => {
    const lines = [
      '2026-10-26T02:59:55 INFO mistralrs_server_core::metrics: request completed status=200',
      '2026-10-26T02:58:47 INFO mistralrs_core::gguf::chat_template: Discovered and using GGUF',
      '2026-10-26T02:46:29 INFO mistralrs::commands::serve: Server listening on http://0.0.0.0:1234',
      'mistral.rs version: 0.9.5',
      'Could not load token at C:\\Users\\x\\.cache\\huggingface\\token',
      'Check mistralrs.exe / see https://mistralrs.dev/install.ps1',
    ];
    for (const l of lines) {
      const out = lib.brand(l);
      assert.doesNotMatch(out, /mistral/i, `leak: ${out}`);
    }
    assert.match(lib.brand('mistralrs::commands::serve: listening'), /ashat/);
    assert.match(lib.brand('mistral.rs version: 0.9.5'), /Ashat version/);
  });
});

describe('persona injection', () => {
  const s = lib.defaultSettings();
  it('prepends the Ashat identity when no system message exists', () => {
    const msgs = lib.ensurePersona(s, [{ role: 'user', content: 'hi' }]);
    assert.equal(msgs[0].role, 'system');
    assert.match(msgs[0].content, /Ashat/);
    assert.equal(msgs[1].role, 'user');
  });
  it("never overrides the caller's own system message", () => {
    const msgs = lib.ensurePersona(s, [{ role: 'system', content: 'custom' }, { role: 'user', content: 'hi' }]);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, 'custom');
  });
  it('handles missing message arrays', () => {
    const msgs = lib.ensurePersona(s, undefined);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'system');
  });
});
