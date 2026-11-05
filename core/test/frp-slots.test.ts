// Unit: fixed visitor ports per service, the apps service in frp configs, frpc restart rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema, type Config } from "../src/config.ts";
import { exposedServices, frpcClientToml, needsFrpcRestart, placeBundle } from "../src/frp.ts";
import type { Secrets } from "../src/secrets.ts";

const store: Record<string, string> = { frpsToken: "frps-secret", sk: "stcp-secret", gateToken: "gate-secret" };
const secrets = { kind: "mem", get: (n: string) => store[n] ?? null, set: () => {} } as unknown as Secrets;

const base = { clientId: "test-client", frps: { addr: "203.0.113.5", port: 7000 } };
const cfgOf = (over: Record<string, unknown> = {}): Config => ConfigSchema.parse({ ...base, ...over });
const officeOn = { apps: { office: { enabled: true } } };

// server name -> bindPort, from the visitor toml and from .mcp.json (both must agree)
function ports(b: { visitorToml: string; mcpJson: string }) {
  const toml: Record<string, number> = {};
  for (const m of b.visitorToml.matchAll(/serverName = "(\w+)"[\s\S]*?bindPort = (\d+)/g)) toml[m[1]] = Number(m[2]);
  const mcp: Record<string, number> = {};
  for (const [k, v] of Object.entries(JSON.parse(b.mcpJson).mcpServers as Record<string, { url: string }>))
    mcp[k.replace(/^bridge-/, "")] = Number(v.url.match(/:(\d+)\/mcp$/)![1]);
  assert.deepEqual(toml, mcp, "visitor toml and .mcp.json disagree");
  return toml;
}

test("placeBundle: terminal + browser on => 47911 / 47912 (live place unchanged)", () => {
  // protects=the live place's ports after the update; fails_when=slots are renumbered or apps shifts terminal/browser; no_claim=frp actually connects
  assert.deepEqual(ports(placeBundle(cfgOf(), secrets)), { terminal: 47911, browser: 47912 });
});

test("placeBundle: browser off + office on => terminal 47911, apps 47913", () => {
  // protects=fixed slot per service; fails_when=ports come from the index in the enabled list; no_claim=the apps gate is listening
  const p = ports(placeBundle(cfgOf({ browser: { enabled: false }, ...officeOn }), secrets));
  assert.deepEqual(p, { terminal: 47911, apps: 47913 });
});

test("placeBundle: a custom base keeps the per-service offsets", () => {
  // protects=base + slot for any base (tests and non-default places); fails_when=the default base is hard-coded or offsets depend on what is on; no_claim=port collisions with other software
  assert.deepEqual(ports(placeBundle(cfgOf(officeOn), secrets, 30000)), { terminal: 30000, browser: 30001, apps: 30002 });
  assert.deepEqual(ports(placeBundle(cfgOf({ browser: { enabled: false }, ...officeOn }), secrets, 30000)), { terminal: 30000, apps: 30002 });
  assert.deepEqual(ports(placeBundle(cfgOf({ terminal: { enabled: false } }), secrets, 30000)), { browser: 30001 });
});

test(".mcp.json has bridge-apps only when office is on", () => {
  // protects=the place sees bridge-apps exactly when a program is on; fails_when=apps is always exported or never; no_claim=content of the apps tools
  const off = JSON.parse(placeBundle(cfgOf(), secrets).mcpJson).mcpServers;
  assert.equal("bridge-apps" in off, false);
  const on = JSON.parse(placeBundle(cfgOf(officeOn), secrets).mcpJson).mcpServers;
  assert.deepEqual(Object.keys(on).sort(), ["bridge-apps", "bridge-browser", "bridge-terminal"]);
  assert.equal(on["bridge-apps"].url, "http://127.0.0.1:47913/mcp");
  assert.equal(on["bridge-apps"].headers.Authorization, "Bearer gate-secret");
});

test("exposedServices / frpcClientToml: apps proxy only when office is on, on apps.port", () => {
  // protects=frpc exposes the apps gate iff a program is on; fails_when=apps is missing or exposed while everything is off; no_claim=frps accepts the proxy
  const off = cfgOf();
  assert.deepEqual(exposedServices(off).map((s) => s.name), ["terminal", "browser"]);
  assert.doesNotMatch(frpcClientToml(off), /name = "apps"/);
  const on = cfgOf({ apps: { port: 48013, office: { enabled: true } } });
  assert.deepEqual(exposedServices(on), [
    { name: "terminal", port: 47811 },
    { name: "browser", port: 47812 },
    { name: "apps", port: 48013 },
  ]);
  assert.match(frpcClientToml(on), /name = "apps"\ntype = "stcp"\nsecretKey = "\{\{ \.Envs\.SB_SK \}\}"\nlocalIP = "127\.0\.0\.1"\nlocalPort = 48013\n/);
});

test("needsFrpcRestart: office on => true", () => {
  // protects=a newly enabled program becomes reachable without a manual frpc restart; fails_when=the restart rule lists fields by hand and misses apps; no_claim=the restart itself succeeds
  assert.equal(needsFrpcRestart(cfgOf(), cfgOf(officeOn)), true);
  assert.equal(needsFrpcRestart(cfgOf(officeOn), cfgOf()), true);
});

test("needsFrpcRestart: frps.addr change => true (it goes through env, not the toml)", () => {
  // protects=moving to another server reconnects frpc; fails_when=only the toml is compared; no_claim=secrets changes (handled by the secrets route)
  assert.equal(frpcClientToml(cfgOf()), frpcClientToml(cfgOf({ frps: { addr: "198.51.100.7", port: 7000 } })));
  assert.equal(needsFrpcRestart(cfgOf(), cfgOf({ frps: { addr: "198.51.100.7", port: 7000 } })), true);
  assert.equal(needsFrpcRestart(cfgOf(), cfgOf({ frps: { addr: "203.0.113.5", port: 7001 } })), true);
});

test("needsFrpcRestart: gate-only settings => false", () => {
  // protects=the tunnel is not dropped for settings frpc does not use; fails_when=the whole config is compared; no_claim=gate restarts for those settings
  assert.equal(needsFrpcRestart(cfgOf(), cfgOf({ terminal: { autoAllow: false } })), false);
  assert.equal(needsFrpcRestart(cfgOf(officeOn), cfgOf({ apps: { office: { enabled: true, trustScripts: true } } })), false);
  assert.equal(needsFrpcRestart(cfgOf(), cfgOf({ browser: { tools: { browser_click: "auto" } } })), false);
});

test("needsFrpcRestart: apps.port change => true only while office is on", () => {
  // protects=frpc follows the apps gate to its new local port; fails_when=apps.port is ignored or restarts frpc while apps is not exposed; no_claim=the gate rebinds to the new port
  assert.equal(needsFrpcRestart(cfgOf(officeOn), cfgOf({ apps: { port: 48013, office: { enabled: true } } })), true);
  assert.equal(needsFrpcRestart(cfgOf(), cfgOf({ apps: { port: 48013 } })), false);
});
