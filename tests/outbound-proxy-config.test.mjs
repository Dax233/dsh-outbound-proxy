import assert from "node:assert/strict";
import { test } from "node:test";

const plugin = await import("../index.js");

const CLASH_DEFAULT = "http://127.0.0.1:7890";

test("an explicit config.proxyUrl wins over the launch environment", () => {
  const resolved = plugin.resolveConfig(
    { proxyUrl: "http://127.0.0.1:7891" },
    { HTTPS_PROXY: "http://127.0.0.1:7897" },
  );
  assert.equal(resolved.proxyUrl, "http://127.0.0.1:7891");
  assert.equal(resolved.source, "config");
});

test("the launch environment is adopted when the row omits proxyUrl", () => {
  const resolved = plugin.resolveConfig({ noProxy: "deepseek.com" }, { HTTPS_PROXY: "http://127.0.0.1:7897" });
  assert.equal(resolved.proxyUrl, "http://127.0.0.1:7897");
  assert.equal(resolved.source, "environment:HTTPS_PROXY");
});

test("lowercase https_proxy has priority over HTTP_PROXY", () => {
  const resolved = plugin.resolveConfig(
    {},
    { https_proxy: "http://127.0.0.1:7897", HTTPS_PROXY: "http://127.0.0.1:7898", HTTP_PROXY: "http://127.0.0.1:7899" },
  );
  assert.equal(resolved.proxyUrl, "http://127.0.0.1:7897");
  assert.equal(resolved.source, "environment:https_proxy");
});

test("HTTP_PROXY is used when HTTPS_PROXY is absent", () => {
  const resolved = plugin.resolveConfig({}, { HTTP_PROXY: "http://127.0.0.1:8090" });
  assert.equal(resolved.proxyUrl, "http://127.0.0.1:8090");
  assert.equal(resolved.source, "environment:HTTP_PROXY");
});

test("the Clash-for-Windows default is the last resort", () => {
  const resolved = plugin.resolveConfig({}, {});
  assert.equal(resolved.proxyUrl, CLASH_DEFAULT);
  assert.equal(resolved.source, "fallback");
});

test("unusable environment entries are skipped", () => {
  const resolved = plugin.resolveConfig(
    {},
    { https_proxy: "socks5://127.0.0.1:1080", HTTPS_PROXY: "not a url", HTTP_PROXY: "http://127.0.0.1:7897" },
  );
  assert.equal(resolved.proxyUrl, "http://127.0.0.1:7897");
  assert.equal(resolved.source, "environment:HTTP_PROXY");
});

test("a missing environment map falls back to the default", () => {
  assert.equal(plugin.resolveConfig({}, null).source, "fallback");
  assert.equal(plugin.resolveConfig({}, {}).source, "fallback");
  assert.deepEqual(plugin.proxyUrlFromEnvironment({}), undefined);
  assert.deepEqual(plugin.proxyUrlFromEnvironment({ HTTPS_PROXY: "  " }), undefined);
});

test("malformed explicit proxyUrl is still rejected", () => {
  for (const bad of [
    { proxyUrl: "" },
    { proxyUrl: "   " },
    { proxyUrl: 7890 },
    { proxyUrl: null },
    { proxyUrl: "not a url" },
    { proxyUrl: "socks5://127.0.0.1:1080" },
  ]) {
    assert.throws(() => plugin.resolveConfig(bad, { HTTPS_PROXY: "http://127.0.0.1:7897" }), /outbound-proxy: config\.proxyUrl/u);
  }
});

test("enabled and noProxy defaults stay stable", () => {
  const resolved = plugin.resolveConfig({}, {});
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.noProxy, "deepseek.com,opencode.ai");

  const off = plugin.resolveConfig({ enabled: false }, {});
  assert.equal(off.enabled, false);

  const explicit = plugin.resolveConfig({ enabled: true, noProxy: "deepseek.com" }, {});
  assert.equal(explicit.noProxy, "deepseek.com");

  const empty = plugin.resolveConfig({ enabled: true, noProxy: "" }, {});
  assert.equal(empty.noProxy, "");
});
