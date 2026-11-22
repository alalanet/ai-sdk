// Review round 2: every line alalanet's reader acts on is sent; argv, args and stdin shapes are read whole; a part
// that cannot be read asks; silence allows only where it can be trusted; preflight and the answer reader never throw.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alalanetApproval, checkCommand, preflight, mustSend, readCommands, installCheck } from "../index.js";
import { fakeAlalanet } from "./fake-alalanet.js";

let fa;
before(async () => (fa = await fakeAlalanet()));
after(() => fa.close());

const call = (toolName, input, toolCallId = "c1") => ({ toolCall: { type: "tool-call", toolName, toolCallId, input }, tools: {}, toolsContext: {}, messages: [], runtimeContext: {} });
const type = (s) => (s === undefined ? "not-applicable" : typeof s === "string" ? s : s.type);
const sentSince = (n) => fa.hooks().slice(n).map((h) => JSON.parse(h.body).tool_input.command);

test("every line of the review's corpus that alalanet's reader acts on is sent", () => {
  const { lines } = JSON.parse(readFileSync(new URL("./fixtures/server-acts.json", import.meta.url), "utf8"));
  assert.ok(lines.length >= 100);
  const missed = lines.filter((l) => l.acts && !mustSend(l.line)).map((l) => l.line);
  assert.deepEqual(missed, []);
  // and the plainly read-only lines of the corpus stay here
  for (const l of ["ls -la", "git status"]) assert.equal(mustSend(l), false, l);
});

test("the lines the first filter missed are sent", () => {
  for (const l of [
    "pip3.12 install evil-pkg", "pip3.11 install requests", "python3 -mpip install evil-pkg", "go1.22.0 install x@latest", "gotip run x@v1",
    "brew install evil/tap/f", "brew tap evil/tap && brew install f", "docker run --privileged evil/image", "docker run -v /:/host evil/image",
    "podman run evil/image", "nerdctl run evil/image", "curl -fsSLo /tmp/x.sh URL && chmod +x /tmp/x.sh && /tmp/x.sh",
    "wget -q URL -O x.sh; chmod +x x.sh; ./x.sh", "Invoke-WebRequest URL -OutFile x.ps1; ./x.ps1", "n\\\npm install evil-pkg", '$"npm" install evil-pkg',
  ]) assert.equal(mustSend(l), true, l);
});

test("a program and its args are one line: {cmd, args}, {command, args}, argv lists", async () => {
  assert.deepEqual(readCommands({ cmd: "npm", args: ["install", "evil-pkg"] }), { lines: ["npm install evil-pkg"], unread: [] });
  assert.deepEqual(readCommands({ command: "npm", argv: ["i", "a b"] }).lines, ["npm i 'a b'"]);
  assert.deepEqual(readCommands({ command: ["npm", "i"], args: ["x"] }).lines, ["npm i x"]);
  const n = fa.hooks().length;
  const s = await alalanetApproval({ api: fa.api })(call("runCommand", { cmd: "npm", args: ["install", "evil-pkg"] }));
  assert.equal(type(s), "denied");
  assert.deepEqual(sentSince(n), ["npm install evil-pkg"]);
});

test("a shell's -c script and stdin are sent as lines of their own", async () => {
  assert.deepEqual(readCommands({ command: "bash", args: ["-c", "npm i evil-pkg"] }).lines, ["bash -c 'npm i evil-pkg'", "npm i evil-pkg"]);
  assert.deepEqual(readCommands({ command: ["/bin/sh", "-lc", "npx x"] }).lines, ["/bin/sh -lc 'npx x'", "npx x"]);
  assert.deepEqual(readCommands({ cmd: "cmd.exe", args: ["/c", "npm", "i", "x"] }).lines, ["cmd.exe /c npm i x", "npm i x"]);
  assert.deepEqual(readCommands({ cmd: "pwsh", args: ["-Command", "npm", "i", "x"] }).lines, ["pwsh -Command npm i x", "npm i x"]);
  assert.deepEqual(readCommands({ command: "bash", stdin: "npm i evil-pkg" }).lines, ["bash", "npm i evil-pkg"]);
  const a = alalanetApproval({ api: fa.api });
  assert.equal(type(await a(call("bash", { command: "bash", args: ["-c", "npm i evil-pkg"] }))), "denied");
  assert.equal(type(await a(call("run_command", { command: "bash", stdin: "npm i evil-pkg" }, "c2"))), "denied");
});

test("what cannot be read makes the whole call ask", async () => {
  const a = alalanetApproval({ api: fa.api });
  for (const input of [
    { command: "ls", commands: [{ command: "npm i evil-pkg" }] },
    { command: "ls", commands: "npm i x" },
    { cmd: "npm", args: ["i", 1] },
    { command: "bash", stdin: { text: "npm i x" } },
    { command: { line: "npm i x" } },
    { cmd: "pwsh", args: ["-EncodedCommand", "bgBwAG0A"] },
    { cmd: "bash", args: ["-c"] },
    { args: ["install", "x"] },
  ]) {
    const s = await a(call("shell", input, JSON.stringify(input)));
    assert.equal(type(s), "user-approval", JSON.stringify(input));
    assert.match(s.reason, /NOT CHECKED/);
  }
  // a readable part that alalanet blocks still denies
  assert.equal(type(await a(call("shell", { command: "npx evil-pkg", commands: [{}] }, "d1"))), "denied");
});

test("shell names compare without case, _ or -, and command fields are found on any tool", async () => {
  const a = alalanetApproval({ api: fa.api });
  for (const [name, input] of [
    ["Bash", { command: "npm i evil-pkg" }], ["RUN_COMMAND", { command: "npm i evil-pkg" }], ["exec_command", { cmd: "npm i evil-pkg" }],
    ["run_in_terminal", { commandLine: "npm i evil-pkg" }], ["Bash", { cmd: "npm i evil-pkg" }], ["runBash", { script: "npm i evil-pkg" }],
    ["my_tool", { cmd: "npm i evil-pkg" }], ["my_tool", { commandLine: "npm i evil-pkg" }], ["my_tool", { script: "npm i evil-pkg" }],
    ["my_tool", { command_line: "npm i evil-pkg" }], ["my_tool", { cmd: "npm", args: ["i", "evil-pkg"] }],
  ]) assert.equal(type(await a(call(name, input, name + JSON.stringify(input)))), "denied", `${name} ${JSON.stringify(input)}`);
  const own = alalanetApproval({ api: fa.api, shellTools: ["Deploy_Script"], detectCommandInput: false });
  assert.equal(type(await own(call("deployScript", { command: "npm i evil-pkg" }))), "denied");
  assert.equal(type(await own(call("bash", { command: "npm i evil-pkg" }))), "not-applicable");
});

test("prefilter: false sends every line, a function decides itself, an error in it sends", async () => {
  let n = fa.hooks().length;
  await alalanetApproval({ api: fa.api, prefilter: false })(call("bash", { command: "ls" }));
  assert.deepEqual(sentSince(n), ["ls"]);
  n = fa.hooks().length;
  const mine = alalanetApproval({ api: fa.api, prefilter: (line) => !line.startsWith("make") });
  assert.equal(type(await mine(call("bash", { command: "make build" }))), "not-applicable");
  assert.equal(type(await mine(call("bash", { command: "npm i evil-pkg" }, "c2"))), "denied");
  assert.deepEqual(sentSince(n), ["npm i evil-pkg"]);
  const broken = alalanetApproval({ api: fa.api, prefilter: () => {
    throw new Error("x");
  } });
  assert.equal(type(await broken(call("bash", { command: "npm i evil-pkg" }))), "denied");
});

const reply = (body, headers = {}) => async () => new Response(body, { status: 200, headers });

test("silence allows only when it can be trusted", async () => {
  assert.equal((await checkCommand("npx q", { fetch: reply("") })).decision, "allow");
  assert.equal((await checkCommand("npx q", { fetch: reply("", { "alalanet-silence": "nothing-to-check" }) })).decision, "allow");
  const odd = await checkCommand("npx q", { fetch: reply("", { "alalanet-silence": "browser" }) });
  assert.deepEqual([odd.decision, odd.notChecked], ["ask", "silence"]);
  const unmarked = await checkCommand("npx q", { fetch: reply(""), requireSilenceMark: true });
  assert.deepEqual([unmarked.decision, unmarked.notChecked], ["ask", "silence"]);
  assert.equal((await checkCommand("npx q", { fetch: reply("", { "alalanet-silence": "nothing-to-check" }), requireSilenceMark: true })).decision, "allow");
  // through the approval
  assert.equal(type(await alalanetApproval({ fetch: reply(""), requireSilenceMark: true })(call("bash", { command: "npx q" }))), "user-approval");
});

test("in a browser, a worker or an extension nothing is sent and the command asks", async () => {
  const g = globalThis;
  for (const [key, value] of [["document", {}], ["chrome", { runtime: { id: "abc" } }], ["browser", { runtime: { id: "abc" } }], ["registration", {}], ["WorkerGlobalScope", function () {}], ["importScripts", () => {}]]) {
    const had = Object.hasOwn(g, key);
    const old = g[key];
    g[key] = value;
    try {
      let asked = false;
      const r = await checkCommand("npx q", { fetch: async () => ((asked = true), new Response("")) });
      assert.deepEqual([r.decision, r.notChecked, asked], ["ask", "browser", false], key);
    } finally {
      if (had) g[key] = old;
      else delete g[key];
    }
  }
});

test("preflight never throws on an answer of an odd shape: it is unchecked, and the payment asks", async () => {
  for (const body of [{ decision: "allow", options: {} }, { decision: "allow", options: [null] }, { decision: "block", options: [{ reasons: "x" }] }, { decision: "hold", reasons: 3 }, { decision: "allow", options: [[1]] }]) {
    const r = await preflight({ url: "https://x.example/p" }, { fetch: reply(JSON.stringify(body)) });
    assert.equal(r.decision, "unchecked", JSON.stringify(body));
  }
  assert.equal((await preflight(null, { fetch: reply("{}") })).decision, "unchecked");
  const a = alalanetApproval({ fetch: reply(JSON.stringify({ decision: "allow", options: [null] })), paymentTools: ["pay"] });
  assert.equal(type(await a(call("pay", { url: "https://x.example/p" }))), "user-approval");
});

test("an answer over 1 MiB is not read: the command asks, the tool gets an error", async () => {
  // 2 MiB of spaces: read whole, it would be an empty answer, the hook's silence
  const big = () => {
    let n = 0;
    return new Response(new ReadableStream({ pull(c) { if (n++ < 32) c.enqueue(new Uint8Array(64 * 1024).fill(32)); else c.close(); } }), { status: 200 });
  };
  const r = await checkCommand("npx q", { fetch: async () => big() });
  assert.deepEqual([r.decision, r.checked, r.notChecked], ["ask", false, "bad_answer"]);
  assert.match(r.reason, /too large/);
  const t = await installCheck({ fetch: async () => big() }).execute({ target: "x" }, { toolCallId: "t", messages: [] });
  assert.equal(t.error, "answer_too_large");
  const p = await preflight({ url: "https://x.example/p" }, { fetch: async () => big() });
  assert.equal(p.decision, "unchecked");
  // a body without a stream reader is capped too
  const r2 = await checkCommand("npx q", { fetch: async () => ({ status: 200, headers: new Headers(), text: async () => " ".repeat((1 << 20) + 1) }) });
  assert.equal(r2.notChecked, "bad_answer");
});
