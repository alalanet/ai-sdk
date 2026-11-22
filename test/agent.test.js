// The approval inside a real AI SDK agent loop, with the SDK's own mock language model (ai/test) and a fake
// alalanet: a blocked command never executes, a held one waits for the user's approval and runs only after it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ToolLoopAgent, generateText, streamText, tool, isStepCount } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { z } from "zod";
import { alalanetApproval } from "../index.js";
import { fakeAlalanet, deadApi } from "./fake-alalanet.js";

let fa;
before(async () => (fa = await fakeAlalanet()));
after(() => fa.close());

const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } };
const done = { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
const callOf = (command, id = "call-1") => ({
  content: [{ type: "tool-call", toolCallId: id, toolName: "runCommand", input: JSON.stringify({ command }) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});

// A model that calls runCommand once with the command, then answers in text.
function model(command) {
  let n = 0;
  return new MockLanguageModelV4({ doGenerate: async () => (n++ === 0 ? callOf(command) : done) });
}

function shell() {
  const ran = [];
  return { ran, runCommand: tool({ description: "Run a shell command", inputSchema: z.object({ command: z.string() }), execute: async ({ command }) => (ran.push(command), "ran") }) };
}

// What the model was told about the tool call in its next step.
function toolOutputs(m) {
  return m.doGenerateCalls
    .flatMap((c) => c.prompt)
    .filter((msg) => msg.role === "tool")
    .flatMap((msg) => msg.content)
    .filter((p) => p.type === "tool-result");
}

test("ToolLoopAgent: a blocked command never executes, and the model gets alalanet's reason", async () => {
  const m = model("npx -y evil-pkg");
  const sh = shell();
  const agent = new ToolLoopAgent({ model: m, tools: { runCommand: sh.runCommand }, toolApproval: alalanetApproval({ api: fa.api }), stopWhen: isStepCount(5) });
  const r = await agent.generate({ prompt: "install it" });
  assert.deepEqual(sh.ran, []);
  assert.equal(r.text, "done");
  const out = toolOutputs(m);
  assert.equal(out.length, 1);
  assert.equal(out[0].output.type, "execution-denied");
  assert.match(out[0].output.reason, /BLOCK\. npm:evil-pkg — osv_malicious/);
});

test("ToolLoopAgent: a held command waits for the user, runs after an approval, not after a refusal", async () => {
  for (const approved of [true, false]) {
    const m = model("npm install brand-new-pkg");
    const sh = shell();
    const agent = new ToolLoopAgent({ model: m, tools: { runCommand: sh.runCommand }, toolApproval: alalanetApproval({ api: fa.api }), stopWhen: isStepCount(5) });
    const messages = [{ role: "user", content: "add brand-new-pkg" }];
    const first = await agent.generate({ messages });
    assert.deepEqual(sh.ran, []);
    const req = first.content.find((p) => p.type === "tool-approval-request");
    assert.ok(req, "an approval request");
    assert.ok(!req.isAutomatic);
    assert.match(req.reason, /HOLD\. npm:brand-new-pkg — new_package/);
    assert.equal(m.doGenerateCalls.length, 1, "the loop stops for the approval");

    messages.push(...first.responseMessages);
    messages.push({ role: "tool", content: [{ type: "tool-approval-response", approvalId: req.approvalId, approved }] });
    await agent.generate({ messages });
    assert.deepEqual(sh.ran, approved ? ["npm install brand-new-pkg"] : []);
  }
});

test("generateText: alalanet unreachable makes the command wait for the user", async () => {
  const sh = shell();
  const r = await generateText({ model: model("npx -y anything"), tools: { runCommand: sh.runCommand }, toolApproval: alalanetApproval({ api: await deadApi() }), stopWhen: isStepCount(5), prompt: "go" });
  assert.deepEqual(sh.ran, []);
  const req = r.content.find((p) => p.type === "tool-approval-request");
  assert.match(req.reason, /NOT CHECKED — alalanet could not be reached/);
});

test("generateText: a command alalanet has nothing to say about runs, and one that installs nothing is not sent", async () => {
  for (const command of ["npm install left-pad", "ls -la"]) {
    const n = fa.hooks().length;
    const sh = shell();
    await generateText({ model: model(command), tools: { runCommand: sh.runCommand }, toolApproval: alalanetApproval({ api: fa.api }), stopWhen: isStepCount(5), prompt: "go" });
    assert.deepEqual(sh.ran, [command]);
    assert.equal(fa.hooks().length, n + (command === "ls -la" ? 0 : 1));
  }
});

test("streamText: a blocked command never executes", async () => {
  let n = 0;
  const m = new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(
        n++ === 0
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call-1", toolName: "runCommand", input: JSON.stringify({ command: "npx -y evil-pkg" }) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "done" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ],
      ),
    }),
  });
  const sh = shell();
  const r = streamText({ model: m, tools: { runCommand: sh.runCommand }, toolApproval: alalanetApproval({ api: fa.api }), stopWhen: isStepCount(5), prompt: "go" });
  assert.equal(await r.text, "done");
  assert.deepEqual(sh.ran, []);
  const out = m.doStreamCalls
    .flatMap((c) => c.prompt)
    .filter((msg) => msg.role === "tool")
    .flatMap((msg) => msg.content)
    .filter((p) => p.type === "tool-result");
  assert.equal(out.length, 1);
  assert.equal(out[0].output.type, "execution-denied");
  assert.match(out[0].output.reason, /BLOCK\. npm:evil-pkg/);
});
