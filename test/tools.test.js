import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { alalanetTools, installCheck } from "../index.js";
import { fakeAlalanet, deadApi } from "./fake-alalanet.js";

let fa;
before(async () => (fa = await fakeAlalanet()));
after(() => fa.close());

const run = (t, input) => t.execute(input, { toolCallId: "t1", messages: [] });

test("the three tools have descriptions and input schemas", () => {
  const t = alalanetTools({ api: "http://127.0.0.1:1" });
  assert.deepEqual(Object.keys(t), ["installCheck", "preflightPayment", "checkRepoConfig"]);
  for (const x of Object.values(t)) {
    assert.ok(x.description.length > 100);
    assert.ok(x.inputSchema);
    assert.equal(typeof x.execute, "function");
  }
});

test("installCheck posts the target and returns the verdict without the signed bundle", async () => {
  const r = await run(installCheck({ api: fa.api }), { target: "npx -y evil-thing" });
  const s = fa.seen.at(-1);
  assert.deepEqual([s.method, s.path, JSON.parse(s.body)], ["POST", "/v1/install-check", { target: "npx -y evil-thing" }]);
  assert.match(s.headers["user-agent"], /^alalanet-ai-sdk\/.+ \(tool\)$/);
  assert.equal(r.decision, "block");
  assert.deepEqual(r.reasons, ["osv_malicious"]);
  assert.equal(r.attestation_id, "a1");
  assert.equal(r.facts, undefined);
  const full = await run(installCheck({ api: fa.api, full: true }), { target: "left-pad" });
  assert.equal(full.attestation.event.id, "a1");
});

test("a used-up daily limit comes back as a result the model can read, with the paid route", async () => {
  const r = await run(installCheck({ api: fa.api }), { target: "quota-pkg" });
  assert.equal(r.error, "quota_exceeded");
  assert.equal(r.retry_after_seconds, 3600);
  assert.match(r.pay_per_call.url, /x402\/install-check/);
});

test("alalanet unreachable is a result, not a throw", async () => {
  const r = await run(installCheck({ api: await deadApi() }), { target: "left-pad" });
  assert.equal(r.error, "alalanet_unreachable");
});

test("preflightPayment: GET with the URL alone, POST with the 402 terms", async () => {
  const t = alalanetTools({ api: fa.api, maxUsdPerCall: 0.02 }).preflightPayment;
  let r = await run(t, { url: "https://bad.example/paid" });
  let s = fa.seen.at(-1);
  assert.deepEqual([s.method, s.query.url, s.query.max_usd], ["GET", "https://bad.example/paid", "0.02"]);
  assert.equal(r.decision, "block");
  r = await run(t, { url: "https://ok.example/paid", paymentRequired: "eyJ4In0=", maxUsd: 0.01 });
  s = fa.seen.at(-1);
  assert.deepEqual(JSON.parse(s.body), { url: "https://ok.example/paid", payment_required: "eyJ4In0=", max_usd: 0.01 });
  assert.equal(r.decision, "allow");
  assert.equal(r.options[0].pay_to, "0xAAA");
});

test("checkRepoConfig: a public repository by name, a local checkout by its files", async () => {
  const t = alalanetTools({ api: fa.api }).checkRepoConfig;
  let r = await run(t, { repo: "someone/trap", ref: "main" });
  assert.deepEqual(fa.seen.at(-1).query, { repo: "someone/trap", ref: "main" });
  assert.equal(r.decision, "block");
  r = await run(t, { files: { ".vscode/tasks.json": "{}" } });
  assert.deepEqual(JSON.parse(fa.seen.at(-1).body), { files: { ".vscode/tasks.json": "{}" } });
  assert.equal(r.decision, "block");
  assert.equal((await run(t, {})).error, "repo_or_files_needed");
});
