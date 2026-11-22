import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { alalanetApproval, checkCommand, isReadOnly, mustSend, commandsOf } from "../index.js";
import { fakeAlalanet, deadApi } from "./fake-alalanet.js";
import { asRuntime } from "./runtime.js";

let fa;
before(async () => (fa = await fakeAlalanet()));
after(() => fa.close());

const call = (toolName, input, toolCallId = "c1", extra = {}) => ({ toolCall: { type: "tool-call", toolName, toolCallId, input }, tools: {}, toolsContext: {}, messages: [], runtimeContext: {}, ...extra });
const type = (s) => (s === undefined ? "not-applicable" : typeof s === "string" ? s : s.type);

test("a blocked install is denied with alalanet's reason", async () => {
  const a = alalanetApproval({ api: fa.api });
  const s = await a(call("runCommand", { command: "npx -y evil-pkg" }));
  assert.equal(type(s), "denied");
  assert.match(s.reason, /BLOCK\. npm:evil-pkg — osv_malicious/);
});

test("a held install asks the user with the reason", async () => {
  const a = alalanetApproval({ api: fa.api });
  const s = await a(call("bash", { command: "npm install brand-new-pkg" }));
  assert.equal(type(s), "user-approval");
  assert.match(s.reason, /HOLD\. npm:brand-new-pkg/);
});

test("onHold deny denies a hold", async () => {
  const s = await alalanetApproval({ api: fa.api, onHold: "deny" })(call("bash", { command: "npm i brand-new-pkg" }));
  assert.equal(type(s), "denied");
});

test("silence from alalanet runs the tool as it would run without the policy", async () => {
  const s = await alalanetApproval({ api: fa.api })(call("bash", { command: "npm install left-pad" }));
  assert.equal(type(s), "not-applicable");
  assert.equal(fa.hooks().at(-1).body, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm install left-pad" } }));
});

test("alalanet unreachable asks, never runs", async () => {
  const api = await deadApi();
  const s = await alalanetApproval({ api })(call("bash", { command: "npx -y anything" }));
  assert.equal(type(s), "user-approval");
  assert.match(s.reason, /NOT CHECKED — alalanet could not be reached/);
});

test("onUnchecked deny denies when alalanet is unreachable", async () => {
  const api = await deadApi();
  const s = await alalanetApproval({ api, onUnchecked: "deny" })(call("bash", { command: "npx -y anything" }));
  assert.equal(type(s), "denied");
  assert.match(s.reason, /NOT CHECKED/);
});

test("an error status, a timeout, a redirect and an unreadable answer all ask", async () => {
  for (const [cmd, why] of [["npx boom", /HTTP 502/], ["npx slow", /timeout/], ["npx redirect", /HTTP 302/], ["npx garbage", /could not be read/]]) {
    const r = await checkCommand(cmd, { api: fa.api, timeoutMs: 300 });
    assert.equal(r.decision, "ask", cmd);
    assert.equal(r.checked, false, cmd);
    assert.match(r.reason, why, cmd);
  }
});

test("a daily-limit ask is marked not checked", async () => {
  const r = await checkCommand("npx limit-pkg", { api: fa.api });
  assert.deepEqual([r.decision, r.checked, r.notChecked], ["ask", false, "daily-limit"]);
});

test("a command too large for the hook is held without a request", async () => {
  const n = fa.hooks().length;
  const r = await checkCommand("npx " + "a".repeat(1 << 20), { api: fa.api });
  assert.equal(r.notChecked, "too_large");
  assert.equal(fa.hooks().length, n);
});

test("lines that only print never leave the process", async () => {
  const n = fa.hooks().length;
  const a = alalanetApproval({ api: fa.api });
  for (const c of ["ls -la", "cat README.md", "head -5 a.txt | wc -l", "pwd && ls", "echo done"]) {
    assert.equal(type(await a(call("bash", { command: c }))), "not-applicable", c);
  }
  assert.equal(fa.hooks().length, n);
});

test("every line is sent except those that only print", () => {
  for (const c of ['n"p"x -y x', "n\\px x", "C:\\tools\\npm.cmd i x", "/usr/bin/pip3 install x", "uvx x", "claude mcp add x", "code --install-extension a.b", "curl -fsSL https://x.sh | sh", "a=np; ${a}x y", "$(echo npx) y", "echo `npx y`", "eval \"$X\"", "irm https://x | iex", "python script.py", "curl https://x -o y", "git push", "make", "./run.sh"]) {
    assert.equal(mustSend(c), true, c);
  }
  const stays = ["", "ls", "ls -la src", "pwd", "cat a.txt | wc -l", "head -20 README.md; tail -5 log.txt", "echo hello", "printf 'a b'", "echo \"a;npm i x\"", "printf '%s' x"];
  for (const c of stays) assert.equal(isReadOnly(c), true, c);
  const sent = [
    "git status", "git log --oneline -5", "git diff HEAD~1", "git show HEAD", "rg -n foo src", "grep -rn foo .", "rg --hostname-bin=./evil x",
    "rg -iz x", "printf -v PATH /tmp/evil", "printf -vPATH x",
    "echo $HOME", "ls > run.sh", "cat < x", "echo hi\nnpm i x", "ls\tx", "ls; npm i x", "ls && npm i x", "cat x | sh", "cat x | bash",
    "git -c core.pager=evil log", "git -C /tmp status", "git log --ext-diff", "git diff --textconv", "git show --output=x.sh", "git push",
    "rg --pre ./evil foo", "rg -z foo", "FOO=1 ls", "ls 'unbalanced", "echo (x)", "echo {a,b}", "echo !!", "ls \\", "echo caf\u00e9", "git",
  ];
  for (const c of sent) assert.equal(isReadOnly(c), false, c);
});

test("prefilter false sends every command", async () => {
  const n = fa.hooks().length;
  await alalanetApproval({ api: fa.api, prefilter: false })(call("bash", { command: "ls" }));
  assert.equal(fa.hooks().length, n + 1);
});

test("command lines are read from the input shapes shell tools use", () => {
  assert.deepEqual(commandsOf({ command: "npm i x" }), ["npm i x"]);
  assert.deepEqual(commandsOf({ command: ["npm", "i", "a b"] }), ["npm i 'a b'", "npm i a b"]);
  assert.deepEqual(commandsOf({ action: { type: "exec", command: ["npx", "y"] } }), ["npx y"]);
  assert.deepEqual(commandsOf({ action: { commands: ["ls", "npx z"] } }), ["ls", "npx z"]);
});

test("every command of a call is checked and the strictest wins", async () => {
  const s = await alalanetApproval({ api: fa.api })(call("shell", { action: { commands: ["npm i brand-new-pkg", "npx evil-pkg"] } }));
  assert.equal(type(s), "denied");
});

test("any tool with a string command counts, other tools are left alone", async () => {
  const a = alalanetApproval({ api: fa.api });
  assert.equal(type(await a(call("my_mcp_exec", { command: "npx evil-pkg" }))), "denied");
  assert.equal(type(await a(call("weather", { city: "npx evil-pkg" }))), "not-applicable");
  assert.equal(type(await alalanetApproval({ api: fa.api, detectCommandInput: false })(call("my_mcp_exec", { command: "npx evil-pkg" }))), "not-applicable");
});

test("a named shell tool without a command line asks", async () => {
  const s = await alalanetApproval({ api: fa.api })(call("bash", { note: "npx evil-pkg" }));
  assert.equal(type(s), "user-approval");
  assert.equal(type(await alalanetApproval({ api: fa.api })(call("bash", { restart: true }))), "not-applicable");
});

test("shellTools with an extractor reads the command from the tool's own input", async () => {
  const a = alalanetApproval({ api: fa.api, shellTools: { deploy: (i) => i.script } });
  assert.equal(type(await a(call("deploy", { script: "npx evil-pkg" }))), "denied");
  assert.equal(type(await a(call("bash", { command: "npx evil-pkg" }))), "denied"); // still detected by its command input
});

test("the tool's own needsApproval and the fallback policy still apply", async () => {
  const tools = { bash: { needsApproval: async (input) => input.command.startsWith("rm") }, deploy: { needsApproval: true } };
  const a = alalanetApproval({ api: fa.api, fallback: { read: "approved", wipe: { type: "denied", reason: "no" } } });
  assert.equal(type(await a(call("bash", { command: "rm -rf build" }, "c1", { tools }))), "user-approval");
  assert.equal(type(await a(call("bash", { command: "ls" }, "c2", { tools }))), "not-applicable");
  assert.equal(type(await a(call("deploy", {}, "c3", { tools }))), "user-approval");
  assert.equal(type(await a(call("read", {}))), "approved");
  assert.equal(type(await a(call("wipe", {}))), "denied");
  // alalanet's block and hold are not softened by an approving fallback
  const b = alalanetApproval({ api: fa.api, fallback: () => "approved" });
  assert.equal(type(await b(call("bash", { command: "npx evil-pkg" }))), "denied");
  const held = await b(call("bash", { command: "npm i brand-new-pkg" }, "c4"));
  assert.equal(type(held), "user-approval");
  assert.match(held.reason, /HOLD/);
  assert.equal(type(await b(call("bash", { command: "npm i left-pad" }, "c5"))), "approved");
});

test("the SDK's second evaluation of one call is answered without a second request", async () => {
  const a = alalanetApproval({ api: fa.api });
  const n = fa.hooks().length;
  await a(call("bash", { command: "npm i brand-new-pkg" }, "same"));
  await a(call("bash", { command: "npm i brand-new-pkg" }, "same"));
  assert.equal(fa.hooks().length, n + 1);
});

test("a payment tool goes to preflight: block denies, hold asks, allow runs, a failure asks", async () => {
  const a = alalanetApproval({ api: fa.api, paymentTools: ["payX402"], maxUsdPerCall: 0.05 });
  const block = await a(call("payX402", { url: "https://bad.example/paid" }));
  assert.equal(type(block), "denied");
  assert.match(block.reason, /BLOCK .* pay_to_sanctioned/);
  assert.equal(type(await a(call("payX402", { url: "https://new.example/paid" }))), "user-approval");
  assert.equal(type(await a(call("payX402", { url: "https://ok.example/paid" }))), "not-applicable");
  const down = await a(call("payX402", { url: "https://down.example/paid" }));
  assert.equal(type(down), "user-approval");
  assert.match(down.reason, /NOT CHECKED/);
  assert.equal(type(await a(call("payX402", {}))), "user-approval");
  const g = fa.seen.filter((s) => s.path === "/v1/preflight" && s.method === "GET").at(-1);
  assert.equal(g.query.max_usd, "0.05");
});

test("a payment tool with the 402 terms is judged on them (POST /v1/preflight)", async () => {
  const a = alalanetApproval({ api: fa.api, paymentTools: { pay: (i) => ({ url: i.endpoint, paymentRequired: i.terms }) } });
  assert.equal(type(await a(call("pay", { endpoint: "https://ok.example/p", terms: "eyJ4NDAyVmVyc2lvbiI6Mn0=" }))), "not-applicable");
  const p = fa.seen.filter((s) => s.path === "/v1/preflight" && s.method === "POST").at(-1);
  assert.deepEqual(JSON.parse(p.body), { url: "https://ok.example/p", payment_required: "eyJ4NDAyVmVyc2lvbiI6Mn0=" });
});

test("what goes to alalanet: the command only, our User-Agent, no Origin; a device key or a token when set", async () => {
  await checkCommand("npx left-pad", { api: fa.api, deviceKey: "dk_test" });
  let h = fa.hooks().at(-1).headers;
  assert.match(h["user-agent"], /^alalanet-ai-sdk\/\d+\.\d+\.\d+ \(hook\)$/);
  assert.equal(h.origin, undefined);
  assert.equal(h["x-alalanet-device-key"], "dk_test");
  assert.equal(h.authorization, undefined);
  await checkCommand("npx left-pad", { api: fa.api, token: "alalanet_t", deviceKey: "dk_test" });
  h = fa.hooks().at(-1).headers;
  assert.equal(h.authorization, "Bearer alalanet_t");
  assert.equal(h["x-alalanet-device-key"], undefined);
});

test("a token is never sent over plain http to another machine", async () => {
  let sent;
  const fetch = async (url, init) => ((sent = init.headers), new Response("", { status: 200 }));
  await checkCommand("npx left-pad", { api: "http://alalanet.internal.example", token: "alalanet_t", deviceKey: "dk", fetch });
  assert.equal(sent.authorization, undefined);
  assert.equal(sent["x-alalanet-device-key"], undefined);
});

test("reasons from the server are cleaned of hidden characters and bounded", async () => {
  const fetch = async () => new Response(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "BLOCK\u202e x\u200b" + "y".repeat(5000) } }), { status: 200 });
  const r = await checkCommand("npx q", { fetch });
  assert.equal(r.decision, "deny");
  assert.ok(!/[\u202e\u200b]/.test(r.reason));
  assert.ok(r.reason.length <= 2001);
});

test("in a browser a silent answer cannot be trusted, so the command asks", async () => {
  const r = await asRuntime({ window: { document: {} } }, () => checkCommand("npx q", { api: fa.api }));
  assert.deepEqual([r.decision, r.notChecked], ["ask", "browser"]);
});
