// Compiled by `npm test` (tsc, no output): the declarations fit the AI SDK's own types.
import { ToolLoopAgent, generateText, streamText, tool, isStepCount, type ToolApprovalConfiguration } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { alalanetApproval, alalanetTools, checkCommand, preflight, mayInstall, type CommandVerdict } from "@alalanet/ai-sdk";

const model = new MockLanguageModelV4();
const runCommand = tool({ inputSchema: z.object({ command: z.string() }), execute: async ({ command }) => command });
const tools = { runCommand, ...alalanetTools({ maxUsdPerCall: 0.05 }) };

const approval = alalanetApproval({
  shellTools: { runCommand: (i: { command: string }) => i.command },
  paymentTools: { buy: (i: { url: string }) => ({ url: i.url, maxUsd: 0.01 }) },
  onHold: "deny",
  onUnchecked: "ask",
  fallback: { runCommand: "user-approval" },
  onDecision: (d) => void d.decision,
});
const asConfig: ToolApprovalConfiguration<typeof tools, unknown> = approval;

new ToolLoopAgent({ model, tools, toolApproval: approval, stopWhen: isStepCount(3) });
void generateText({ model, tools, toolApproval: approval, prompt: "x" });
void streamText({ model, tools, toolApproval: approval, prompt: "x" });

const v: Promise<CommandVerdict> = checkCommand("npx x", { timeoutMs: 1000 });
void preflight({ url: "https://x.example/paid" });
const b: boolean = mayInstall("npx x");
void [asConfig, v, b];
