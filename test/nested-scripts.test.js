// Compound, wrapped and nested PowerShell and cmd lines, whole-word tool names, and browserLike's order of checks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alalanetApproval, readCommands } from "../index.js";
import { browserLike } from "../core.js";
import { fakeAlalanet } from "./fake-alalanet.js";
import { asRuntime } from "./runtime.js";

let fa;
before(async () => (fa = await fakeAlalanet()));
after(() => fa.close());
const ctx = (toolName, input) => ({ toolCall: { toolName, toolCallId: toolName + JSON.stringify(input), input }, tools: {}, toolsContext: {}, messages: [] });
const type = (s) => (s === undefined ? "not-applicable" : typeof s === "string" ? s : s.type);
const SCRIPT = "npm i evil-pkg";

test("compound, wrapped and nested PowerShell and cmd lines: the script is read", () => {
  const { lines } = JSON.parse(readFileSync(new URL("./fixtures/server-acts-nested-scripts.json", import.meta.url), "utf8"));
  assert.equal(lines.length, 13);
  for (const { line } of lines) {
    const r = readCommands({ command: line });
    assert.ok(r.lines.includes(SCRIPT), line);
    assert.deepEqual(r.unread, [], line);
  }
  for (const line of [
    "cd x; cmd /cnpm i evil-pkg", "powershell -NoProfile -ExecutionPolicy Bypass npm i evil-pkg", "powershell -ex:Bypass npm i evil-pkg",
    "FOO=1 sudo -u root env -i PATH=/usr/bin nice -n 5 timeout -s KILL 60 pwsh -comm 'npm i evil-pkg'",
    "stdbuf -oL xargs -n 1 pwsh -c 'npm i evil-pkg'", "exec -a x command pwsh -comm 'npm i evil-pkg'",
    "(cd x && pwsh -comm 'npm i evil-pkg')", "if true; then pwsh -comm 'npm i evil-pkg'; fi",
    "env -S \"pwsh -comm 'npm i evil-pkg'\"",
  ]) assert.ok(readCommands({ command: line }).lines.includes(SCRIPT), line);
  for (const argv of [["env", "pwsh", "-comm", SCRIPT], ["sudo", "powershell", "npm", "i", "evil-pkg"], ["bash", "-c", `pwsh -comm '${SCRIPT}'`], ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoProfile", "npm", "i", "evil-pkg"]]) {
    assert.ok(readCommands({ command: argv }).lines.includes(SCRIPT), JSON.stringify(argv));
  }
  // every part of a compound line is judged as a line of its own
  assert.deepEqual(readCommands({ command: "cd /tmp && npm i evil-pkg" }).lines, ["cd /tmp && npm i evil-pkg", "cd /tmp", SCRIPT]);
  // nesting is bounded: past four levels the call asks
  let deep = SCRIPT;
  for (let i = 0; i < 6; i++) deep = `sh -c ${JSON.stringify(deep)}`;
  assert.ok(readCommands({ command: deep }).unread.some((u) => /nested/.test(u)));
});

test("through the approval: a blocked script inside a compound, wrapped or nested line is denied", async () => {
  const fetch = async (url, init) => {
    const line = JSON.parse(init.body).tool_input.command;
    // as the real reader on these lines: silent on the compound line, a block on the bare script
    if (line !== SCRIPT) return new Response("", { status: 200 });
    return new Response(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "alalanet install_check: BLOCK. npm:evil-pkg" } }), { status: 200 });
  };
  const a = alalanetApproval({ fetch });
  for (const command of ["cd /tmp && pwsh -comm 'npm i evil-pkg'", "sudo powershell npm i evil-pkg", "sh -c 'pwsh -comm \"npm i evil-pkg\"'", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe npm i evil-pkg"]) {
    assert.equal(type(await a(ctx("bash", { command }))), "denied", command);
  }
});

test("the name rule matches whole words; a pid or a terminal id with text is a process's input", async () => {
  const a = alalanetApproval({ api: fa.api });
  for (const [name, input] of [["do", { pid: 1, input: SCRIPT }], ["bash_tool", { pid: 1, input: SCRIPT }], ["send", { terminalId: 3, text: `${SCRIPT}\n` }], ["replInput", { sessionId: "s", text: SCRIPT }], ["screen_stuff", { text: SCRIPT }], ["send_command", { session_id: "s", text: SCRIPT }], ["consoleWrite", { data: SCRIPT }]]) {
    assert.equal(type(await a(ctx(name, input))), "denied", name);
  }
  const n0 = fa.hooks().length;
  for (const [name, input] of [
    ["rerun_report", { session_id: "s", text: "chat text with sk-live-123" }],
    ["truncate_notes", { session_id: "s", text: "notes" }],
    ["prune_history", { session_id: "s", text: "notes" }],
    ["executive_summary", { session_id: "s", text: "board notes" }],
    ["command_palette_note", { session_id: "s", text: "x" }],
    ["keyskeeper", { session_id: "s", text: "x" }],
  ]) assert.equal(type(await a(ctx(name, input))), "not-applicable", name);
  assert.equal(fa.hooks().length, n0, "nothing sent");
});

test("browserLike after the reorder", () => {
  assert.equal(asRuntime({ chrome: { runtime: { id: "abc" } }, process: { versions: { node: "22" } } }, browserLike), true);
  assert.equal(browserLike(), false);
});
