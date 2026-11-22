// The review's round-3 attack tests (C-1 to C-5), kept as tests of the fixes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { alalanetApproval, readCommands, isReadOnly, shellScript } from "../index.js";
import { browserLike } from "../core.js";
import { fakeAlalanet } from "./fake-alalanet.js";
import { asRuntime } from "./runtime.js";

let fa;
before(async () => (fa = await fakeAlalanet()));
after(() => fa.close());
const ctx = (toolName, input) => ({ toolCall: { toolName, toolCallId: toolName + JSON.stringify(input), input }, tools: {}, toolsContext: {}, messages: [] });
const type = (s) => (s === undefined ? "not-applicable" : typeof s === "string" ? s : s.type);

test("C-1 the two-line rule reads an argv argument as shell too: the safe direction (kept, R3-6)", () => {
  const r = readCommands({ command: "git", args: ["commit", "-m", "x && npm i evil-pkg"] });
  // the joined line's parts are judged too (round 5)
  assert.deepEqual(r.lines, ["git commit -m 'x && npm i evil-pkg'", "git commit -m x && npm i evil-pkg", "git commit -m x", "npm i evil-pkg"]);
  assert.deepEqual(readCommands({ command: ["bash", "-lc", "npm i evil-pkg"] }).lines, ["bash -lc 'npm i evil-pkg'", "npm i evil-pkg", "bash -lc npm i evil-pkg", "npm"]);
});

test("C-2 PowerShell: every parameter form, and Windows PowerShell's positional -Command", () => {
  const out = {};
  for (const f of ["-c", "-co", "-con", "-config", "-cwa", "-CommandWithArgs", "-commandw", "-e", "-ex", "-ep", "/enc", "--encodedcommand", "-f", "-File"]) {
    // the argv as PowerShell reads it (the joined line of the same argv is read as well, and asks for some)
    const r = shellScript(["pwsh", f, "npm i evil-pkg"]);
    out[f] = r.encoded || r.fileUnread ? "ask" : r.script === "npm i evil-pkg" ? "script" : "-";
  }
  assert.deepEqual(out, {
    "-c": "script", "-co": "script", "-con": "-", "-config": "-", "-cwa": "script", "-CommandWithArgs": "script", "-commandw": "script",
    "-e": "ask", "-ex": "-", "-ep": "-", "/enc": "ask", "--encodedcommand": "ask", "-f": "-", "-File": "-",
  });
  // Windows PowerShell 5.1 runs positional words as -Command, after its switches and valued parameters
  for (const input of [
    { command: ["powershell", "npm", "i", "evil-pkg"] },
    { command: ["powershell.exe", "-NoProfile", "npm", "i", "evil-pkg"] },
    { command: ["powershell", "-ExecutionPolicy", "Bypass", "-NoLogo", "npm", "i", "evil-pkg"] },
    { command: ["powershell", "-ExecutionPolicy:Bypass", "npm", "i", "evil-pkg"] },
    { command: "powershell npm i evil-pkg" },
    { command: "powershell -NoProfile npm i evil-pkg" },
    { cmd: "powershell", args: ["-WindowStyle", "Hidden", "npm", "i", "evil-pkg"] },
  ]) {
    const r = readCommands(input);
    assert.ok(r.lines.includes("npm i evil-pkg"), JSON.stringify(input));
    assert.deepEqual(r.unread, [], JSON.stringify(input));
  }
  // pwsh 7 takes the first positional word as -File: a script file this side cannot read asks
  for (const input of [{ command: ["pwsh", "npm", "i", "evil-pkg"] }, { command: "pwsh -NoProfile ./setup.ps1" }]) assert.ok(readCommands(input).unread.length > 0, JSON.stringify(input));
});

test("C-2c bash options with a value before -c", () => {
  assert.ok(readCommands({ command: ["bash", "--rcfile", "x", "-c", "npm i evil-pkg"] }).lines.includes("npm i evil-pkg"));
  assert.ok(readCommands({ command: "bash -o pipefail -lc 'npm i evil-pkg'" }).lines.includes("npm i evil-pkg"));
});

test("C-2b cmd's /c, /k, /r glued to the script", () => {
  for (const input of [{ command: ["cmd", "/cnpm", "i", "evil-pkg"] }, { command: ["cmd", '/C"npm i evil-pkg"'] }, { command: ["cmd.exe", "/knpm i evil-pkg"] }, { command: ["cmd", "/rnpm", "i", "evil-pkg"] }, { command: "cmd /cnpm i evil-pkg" }, { command: 'cmd /C"npm i evil-pkg"' }]) {
    assert.ok(readCommands(input).lines.includes("npm i evil-pkg"), JSON.stringify(input));
  }
});

test("C-3 terminals are read; chat and voice tools with a session and a text are not", async () => {
  const a = alalanetApproval({ api: fa.api });
  for (const [name, input] of [
    ["send_to_terminal", { terminalId: 3, text: "npm i evil-pkg\n" }],
    ["write_terminal", { terminal_id: 3, data: "npm i evil-pkg\n" }],
    ["tmux_send", { target: "main:0", keys: "npm i evil-pkg Enter" }],
    ["terminal_computer", { action: "type", text: "npm i evil-pkg\n" }],
    ["exec_input", { terminalId: 3, text: "npm i evil-pkg\n" }],
    ["run_input", { terminal_id: 2, data: "npm i evil-pkg\n" }],
  ]) assert.equal(type(await a(ctx(name, input))), "denied", name);
  const n0 = fa.hooks().length;
  for (const [name, input] of [
    ["computer", { action: "type", text: "npm i evil-pkg\n" }],
    ["send_message", { session_id: "chat-1", text: "here is my API key sk-live-123" }],
    ["text_to_speech", { sessionId: "s", text: "hello" }],
  ]) assert.equal(type(await a(ctx(name, input))), "not-applicable", name);
  assert.equal(fa.hooks().length, n0, "nothing sent");
});

test("C-4 extension and worker marks win over a spoofed user agent or a process polyfill", () => {
  assert.equal(asRuntime({ chrome: { runtime: { id: "abcdefghijklmnop" } }, navigator: { userAgent: "Cloudflare-Workers" } }, browserLike), true);
  assert.equal(asRuntime({ chrome: { runtime: { id: "abc" } }, process: { versions: { node: "18.0.0" }, env: {} } }, browserLike), true);
  assert.equal(asRuntime({ registration: {}, navigator: { userAgent: "Cloudflare-Workers" } }, browserLike), true);
  assert.equal(asRuntime({ importScripts: () => {}, Deno: { version: { deno: "2" } } }, browserLike), true);
  assert.equal(asRuntime({ process: { type: "renderer", versions: { node: "22" } } }, browserLike), true);
  // a server runtime is still one
  assert.equal(asRuntime({ WorkerGlobalScope: function () {}, navigator: { userAgent: "Cloudflare-Workers" } }, browserLike), false);
  assert.equal(browserLike(), false);
});

test("C-5 the read-only list: a network share is sent", () => {
  const rows = Object.fromEntries(["ls *", "cat -- -v", "printf %s -v", "printf -- -vX", "tail -f x", "echo hi | cat", "ls //evil.example/share", "cat //host/x", "cat 'a&b'", "echo \"x\"'y'"].map((l) => [l, isReadOnly(l)]));
  assert.deepEqual(rows, { "ls *": true, "cat -- -v": true, "printf %s -v": false, "printf -- -vX": false, "tail -f x": true, "echo hi | cat": true, "ls //evil.example/share": false, "cat //host/x": false, "cat 'a&b'": true, "echo \"x\"'y'": true });
});
