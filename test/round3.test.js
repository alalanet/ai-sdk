// Review round 3: shell-joined args, process input, PowerShell's parameter prefixes, server runtimes, a smaller
// read-only list.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { alalanetApproval, readCommands, isReadOnly } from "../index.js";
import { fakeAlalanet } from "./fake-alalanet.js";

let fa;
before(async () => (fa = await fakeAlalanet()));
after(() => fa.close());
const ctx = (toolName, input) => ({ toolCall: { toolName, toolCallId: toolName + JSON.stringify(input), input }, tools: {}, toolsContext: {}, messages: [] });
const type = (s) => (s === undefined ? "not-applicable" : typeof s === "string" ? s : s.type);

test("PowerShell's -Command is read from any prefix, as a line or as argv", () => {
  for (const f of ["-c", "-co", "-com", "-comm", "-comma", "-comman", "-command", "-Command", "--command", "/Command", "/c", "-CommandWithArgs", "-cwa"]) {
    assert.ok(readCommands({ command: ["pwsh", "-NoProfile", f, "npm i evil-pkg"] }).lines.includes("npm i evil-pkg"), f);
    assert.ok(readCommands({ command: `pwsh -NoProfile ${f} 'npm i evil-pkg'` }).lines.includes("npm i evil-pkg"), `line ${f}`);
  }
  // other parameters are not taken for -Command or -EncodedCommand
  for (const f of ["-ConfigurationName", "-NoLogo", "-ExecutionPolicy", "-ex", "-ep"]) {
    const r = readCommands({ command: ["pwsh", f, "x"] });
    assert.deepEqual([r.lines.includes("x"), r.unread], [false, []], f);
  }
  // a one-command line's shell script: bash -c, cmd /s /c
  assert.ok(readCommands({ command: "bash -lc 'npm i evil-pkg'" }).lines.includes("npm i evil-pkg"));
  assert.ok(readCommands({ command: 'cmd /s /c "npm i evil-pkg"' }).lines.includes("npm i evil-pkg"));
});

test("process tools and process fields: input, chars, data, text, keys are command lines", async () => {
  const a = alalanetApproval({ api: fa.api });
  for (const [name, input] of [
    ["send_input", { session_id: "s", text: "npm i evil-pkg" }],
    ["send_keys", { target: "%1", keys: "npm i evil-pkg" }],
    ["write_to_process", { data: "npm i evil-pkg\n" }],
    ["tmux_type", { processId: 7, text: "npm i evil-pkg" }],
    ["anything", { sessionId: "x", data: "npm i evil-pkg" }],
    ["launch", { executable: "/usr/bin/npm", arguments: ["install", "evil-pkg"] }],
    ["launch", { program: "npx", args: ["-y", "evil-pkg"] }],
    ["bash", { command: "bash", input: "npm i evil-pkg" }],
  ]) assert.equal(type(await a(ctx(name, input))), "denied", `${name} ${JSON.stringify(input)}`);
  // text of another shape asks
  assert.equal(type(await a(ctx("interact_with_process", { pid: 1, input: { line: "npm i evil-pkg" } }))), "user-approval");
  // a file with no args is not a command, and a plain text field without a process is not a shell
  const n = fa.hooks().length;
  assert.equal(type(await a(ctx("read_file", { file: "a.txt" }))), "not-applicable");
  assert.equal(type(await a(ctx("translate", { text: "npm i evil-pkg" }))), "not-applicable");
  assert.equal(fa.hooks().length, n);
});

test("the read-only list is ls, pwd, cat, head, tail, wc, echo and printf only", () => {
  for (const l of ["ls -la", "pwd", "cat a", "head -3 a", "tail -n 2 a", "wc -l a", "echo x", "printf '%s' x", "cat a | wc -l"]) assert.equal(isReadOnly(l), true, l);
  for (const l of ["grep x a", "egrep x a", "fgrep x a", "rg x", "git status", "git log", "printf -v X y", "printf -vX y", "sed -n 1p a", "find .", "less a"]) assert.equal(isReadOnly(l), false, l);
});
