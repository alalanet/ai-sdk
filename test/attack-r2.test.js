// The review's round-2 attack tests (B-1 to B-6), kept as tests of the fixes: each first proved a gap, each now
// proves it closed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { alalanetApproval, readCommands, isReadOnly, checkCommand } from "../index.js";
import { fakeAlalanet } from "./fake-alalanet.js";

let fa;
before(async () => (fa = await fakeAlalanet()));
after(() => fa.close());
const ctx = (toolName, input) => ({ toolCall: { toolName, toolCallId: JSON.stringify(input), input }, tools: {}, toolsContext: {}, messages: [] });
const type = (s) => (s === undefined ? "not-applicable" : typeof s === "string" ? s : s.type);
const sentSince = (n) => fa.hooks().slice(n).map((h) => JSON.parse(h.body).tool_input.command);

test("B-1 {command:'npm install', args:[pkg]} is sent as argv and as the line a shell:true tool runs", async () => {
  const { lines, unread } = readCommands({ command: "npm install", args: ["evil-pkg"] });
  assert.deepEqual([lines, unread], [["'npm install' evil-pkg", "npm install evil-pkg"], []]);
  // what a tool with spawn's shell: true runs is the second line
  const bin = mkdtempSync(join(tmpdir(), "alalanet-fakebin-"));
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "RAN npm $*" >> ${bin}/log\n`);
  chmodSync(join(bin, "npm"), 0o755);
  writeFileSync(join(bin, "log"), "");
  spawnSync("npm install", ["evil-pkg"], { shell: true, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(readFileSync(join(bin, "log"), "utf8").trim(), "RAN npm install evil-pkg");
  assert.deepEqual(readCommands({ command: "npx", args: ["-y evil-pkg"] }).lines, ["npx '-y evil-pkg'", "npx -y evil-pkg"]);
  // as the real reader: silent on the quoted line, a block on the plain one; the call is denied, both were sent
  const sent = [];
  const fetch = async (url, init) => {
    const line = JSON.parse(init.body).tool_input.command;
    sent.push(line);
    if (line !== "npm install evil-pkg") return new Response("", { status: 200 });
    return new Response(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "alalanet install_check: BLOCK. npm:evil-pkg" } }), { status: 200 });
  };
  assert.equal(type(await alalanetApproval({ fetch })(ctx("runCommand", { command: "npm install", args: ["evil-pkg"] }))), "denied");
  assert.deepEqual(sent, ["'npm install' evil-pkg", "npm install evil-pkg"]);
});

test("B-2 text written into a running process, and a spawn tool's {file, args}, are checked", async () => {
  const a = alalanetApproval({ api: fa.api });
  let n = fa.hooks().length;
  assert.equal(type(await a(ctx("interact_with_process", { pid: 4242, input: "npm i evil-pkg" }))), "denied");
  assert.deepEqual(sentSince(n), ["npm i evil-pkg"]);
  assert.deepEqual(readCommands({ command: "bash", input: "npm i evil-pkg" }), { lines: ["bash", "npm i evil-pkg"], unread: [] });
  assert.equal(type(await a(ctx("write_stdin", { session_id: 1, chars: "npm i evil-pkg\n" }))), "denied");
  n = fa.hooks().length;
  assert.equal(type(await a(ctx("spawn_process", { file: "npm", args: ["i", "evil-pkg"] }))), "denied");
  assert.deepEqual(sentSince(n), ["npm i evil-pkg"]);
});

test("B-3 every prefix and form of pwsh -EncodedCommand is read as encoded, and the call asks", async () => {
  for (const f of ["-e", "-ec", "-en", "-enc", "-encod", "-encode", "-encoded", "-EncodedC", "-encodedcommand", "--encodedcommand", "/enc", "/EncodedCommand"]) {
    assert.ok(readCommands({ command: ["pwsh", f, "SQBFAFgA"] }).unread.length > 0, f);
    assert.ok(readCommands({ command: `powershell ${f} SQBFAFgA` }).unread.length > 0, `line ${f}`);
  }
  assert.equal(type(await alalanetApproval({ api: fa.api })(ctx("shell", { command: ["pwsh", "-encod", "SQBFAFgA"] }))), "user-approval");
});

test("B-4 rg, grep, git and printf -v are no longer kept local", () => {
  const lines = ["rg --hostname-bin=./evil --hyperlink-format=default TODO", "rg -iz TODO", "rg TODO *", "git status", "git diff", "git log -p", "git log -1 --outp=/tmp/x", "printf -v PATH /tmp/evil:/usr/bin"];
  for (const l of lines) assert.equal(isReadOnly(l), false, l);
  for (const l of ["rg --pre=sh TODO", "rg -z TODO", "git log --output=/tmp/x", "git -c core.pager=x log", "git diff --ext-diff"]) assert.equal(isReadOnly(l), false, l);
});

test("B-5 a global document in a server process (jsdom, happy-dom, linkedom) does not stop the check", async () => {
  globalThis.document = {};
  try {
    const n = fa.hooks().length;
    const r = await checkCommand("npm i lodash", { api: fa.api });
    assert.equal(r.decision, "allow");
    assert.equal(fa.hooks().length, n + 1);
  } finally {
    delete globalThis.document;
  }
});

test("B-6 prototype keys and odd shapes from JSON", async () => {
  const a = alalanetApproval({ api: fa.api });
  const input = JSON.parse('{"__proto__":{"command":"npm i evil-pkg"}}');
  assert.equal(type(await a(ctx("bash", input))), "user-approval"); // a named shell with nothing readable asks
  const parsed = z.object({ command: z.string().optional() }).passthrough().parse(input);
  assert.equal(parsed.command, undefined);
  assert.ok(readCommands({ command: [["npm", "i", "evil-pkg"]] }).unread.length > 0);
  assert.equal(type(await a(ctx("bash", { command: "npm", args: ["i", "evil-pkg\u0000x"] }))), "denied");
});
