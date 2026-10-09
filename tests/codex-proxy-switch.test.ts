import { expect, test } from "bun:test";

/** Run the Python switcher against isolated TOML fixtures. */
function checkFixture(code: string): void {
  const result = Bun.spawnSync(["python3", "-c", `import runpy, tomllib
s = runpy.run_path('scripts/codex-proxy-switch')
${code}`]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
}

test("proxy switch deduplicates commented routing keys", () => {
  checkFixture(`c = 'model = "official"\\n' + ('# model_catalog_json = "/tmp/catalog.json"\\n# openai_base_url = "http://127.0.0.1:10100/v1"\\n' * 6)
r = s['switch_to_proxy'](c)
d = tomllib.loads(r)
assert d['openai_base_url'] == 'http://127.0.0.1:10100/v1'
assert d['model_catalog_json'] == '/tmp/catalog.json'
assert s['switch_to_proxy'](r) == r`);
});

test("proxy URL is inserted at root and nested settings remain unchanged", () => {
  checkFixture(`c = 'model = "official"\\n[profiles.custom]\\n# openai_base_url = "https://example.com/v1"\\nmodel = "nested"\\n'
d = tomllib.loads(s['switch_to_proxy'](c))
assert d['openai_base_url'] == 'http://127.0.0.1:10100/v1'
assert 'openai_base_url' not in d['profiles']['custom']
assert d['profiles']['custom']['model'] == 'nested'`);
});

test("active routing settings take precedence over stale comments", () => {
  checkFixture(`c = '# openai_base_url = "http://stale/v1"\\nopenai_base_url = "http://current/v1"\\n'
d = tomllib.loads(s['switch_to_proxy'](c))
assert d['openai_base_url'] == 'http://current/v1'`);
});

test("proxy model survives direct and proxy round trip", () => {
  checkFixture(`c = 'model = "provider/model"\\nopenai_base_url = "http://127.0.0.1:10100/v1"\\n[profiles.custom]\\nmodel = "provider/nested"\\n'
r = s['switch_to_proxy'](s['switch_to_direct'](c))
d = tomllib.loads(r)
assert d['model'] == 'provider/model'
assert d['profiles']['custom']['model'] == 'provider/nested'`);
});

test("invalid TOML never replaces the existing config", () => {
  checkFixture(`import tempfile
from pathlib import Path
with tempfile.TemporaryDirectory() as directory:
    p = Path(directory) / 'config.toml'
    p.write_text('model = "original"\\n')
    s['write_config'].__globals__['CONFIG_FILE'] = p
    try:
        s['write_config']('model = "first"\\nmodel = "second"\\n')
    except tomllib.TOMLDecodeError:
        pass
    else:
        raise AssertionError('invalid TOML accepted')
    assert p.read_text() == 'model = "original"\\n'`);
});
