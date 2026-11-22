// alalanetApproval: the AI SDK's toolApproval (ToolLoopAgent, generateText, streamText) that asks alalanet before a
// shell command or a payment runs. block -> denied with alalanet's reasons; hold -> the user decides; alalanet could
// not check -> the user decides (or denied with onUnchecked: "deny"), never a silent run.

import { checkCommand, preflight, settings, shown } from "./core.js";
import { mayInstall } from "./filter.js";

// Tool names treated as a shell by default; any tool whose input has a string `command` counts as well.
export const DEFAULT_SHELL_TOOLS = [
  "bash", "shell", "sh", "terminal", "exec", "execute", "run", "runCommand", "run_command", "runShell", "run_shell",
  "executeCommand", "execute_command", "shellCommand", "shell_command", "local_shell", "runTerminalCommand",
  "run_terminal_cmd", "sandbox", "codeExecution",
];

// The command lines in a shell tool's input: command (a string, or argv as an array), commands (a list), cmd, and
// the same under action (OpenAI's shell and local_shell tools).
export function commandsOf(input) {
  const out = [];
  const add = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out.push(v.map(quote).join(" "));
  };
  for (const src of [input, input?.action]) {
    if (!src || typeof src !== "object") continue;
    add(src.command);
    add(src.cmd);
    if (Array.isArray(src.commands)) for (const c of src.commands) add(c);
  }
  return out;
}

function quote(a) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;
}

const RANK = { "not-applicable": 0, approved: 1, "user-approval": 2, denied: 3 };
function kind(status) {
  if (status === undefined || status === null) return "not-applicable";
  return typeof status === "string" ? status : status.type || "not-applicable";
}
// The stricter of two statuses (denied > user-approval > approved > not-applicable).
function stricter(a, b) {
  return RANK[kind(b)] > RANK[kind(a)] ? b : a;
}

// A list replaces the defaults; a map of extractors adds to them.
function nameSet(list, defaults) {
  if (list === undefined || list === null) return { has: (n) => defaults.includes(n), get: () => undefined };
  if (Array.isArray(list)) return { has: (n) => list.includes(n), get: () => undefined };
  return { has: (n) => Object.hasOwn(list, n) || defaults.includes(n), get: (n) => (Object.hasOwn(list, n) ? list[n] : undefined) };
}

/**
 * @param {import("./index").AlalanetApprovalOptions} opts
 * @returns {import("./index").AlalanetApproval}
 */
export function alalanetApproval(opts = {}) {
  const s = settings(opts);
  const o = { ...opts, __settings: s };
  const shell = nameSet(opts.shellTools, DEFAULT_SHELL_TOOLS);
  const pay = nameSet(opts.paymentTools ?? {}, []);
  const onHold = opts.onHold || "ask";
  const onUnchecked = opts.onUnchecked || "ask";
  const prefilter = opts.prefilter !== false;
  const detect = opts.detectCommandInput !== false;
  // The SDK evaluates the policy again when an approval comes back: the same call is answered from here, without a
  // second request (and a second check of the daily limit). Bounded, ten minutes.
  const memo = new Map();
  const MEMO_MAX = 500;
  const MEMO_MS = 10 * 60 * 1000;
  const remember = (key, fn) => {
    const now = Date.now();
    const hit = memo.get(key);
    if (hit && now - hit.at < MEMO_MS) return hit.p;
    const p = fn();
    memo.set(key, { at: now, p });
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    // a failure is not remembered: the next evaluation asks again
    p.then((v) => v.unchecked && memo.get(key)?.p === p && memo.delete(key), () => memo.delete(key));
    return p;
  };

  const report = (d) => {
    try {
      opts.onDecision?.(d);
    } catch {}
  };

  function hold(reason) {
    return onHold === "deny" ? { type: "denied", reason } : { type: "user-approval", reason };
  }
  function unchecked(reason) {
    return onUnchecked === "deny" ? { type: "denied", reason } : { type: "user-approval", reason };
  }

  async function judgeCommands(toolName, toolCallId, lines) {
    let status;
    for (const line of lines) {
      if (prefilter && !mayInstall(line)) continue;
      const v = await remember(`c\0${toolCallId}\0${line}`, async () => {
        const r = await checkCommand(line, o);
        return { ...r, unchecked: !r.checked && r.decision === "ask" };
      });
      report({ kind: "command", toolName, toolCallId, decision: v.decision, reason: v.reason, checked: v.checked, notChecked: v.notChecked });
      let st;
      if (v.decision === "deny") st = { type: "denied", reason: v.reason };
      else if (v.decision === "ask") st = v.checked ? hold(v.reason) : unchecked(v.reason);
      status = stricter(status, st);
      if (kind(status) === "denied") break;
    }
    return status;
  }

  async function judgePayment(toolName, toolCallId, input) {
    const pick = pay.get(toolName);
    let p;
    try {
      p = typeof pick === "function" ? await pick(input) : { url: input?.url, paymentRequired: input?.paymentRequired ?? input?.payment_required };
    } catch (e) {
      return unchecked(`alalanet preflight: NOT CHECKED — the payment's URL could not be read (${shown(e?.message || e, 200)})`);
    }
    if (typeof p === "string") p = { url: p };
    if (!p?.url) return unchecked("alalanet preflight: NOT CHECKED — the tool call names no URL to pay");
    if (opts.maxUsdPerCall !== undefined && p.maxUsd === undefined) p = { ...p, maxUsd: opts.maxUsdPerCall };
    const v = await remember(`p\0${toolCallId}\0${JSON.stringify(p)}`, async () => {
      const r = await preflight(p, o);
      return { ...r, unchecked: r.decision === "unchecked" };
    });
    const why = v.reasons.length ? v.reasons.join(", ") : v.error || "";
    report({ kind: "payment", toolName, toolCallId, url: p.url, decision: v.decision, reasons: v.reasons });
    switch (v.decision) {
      case "block":
        return { type: "denied", reason: `alalanet preflight: BLOCK ${shown(p.url, 300)} — ${why}. Do not pay; tell the user.` };
      case "hold":
        return hold(`alalanet preflight: HOLD ${shown(p.url, 300)} — ${why}. Pay only if the user confirms.`);
      case "allow":
        return undefined;
      default:
        return unchecked(`alalanet preflight: NOT CHECKED ${shown(p.url, 300)} — ${why || "alalanet did not answer"}. Pay only if the user confirms.`);
    }
  }

  // A toolApproval function replaces every tool's own needsApproval in the SDK, so the tool's own setting is read
  // here, then your fallback policy; the strictest status wins.
  async function own(call, ctx) {
    const t = ctx.tools && Object.hasOwn(ctx.tools, call.toolName) ? ctx.tools[call.toolName] : undefined;
    const na = t?.needsApproval;
    if (na == null) return undefined;
    const need = typeof na === "function" ? await na(call.input, { toolCallId: call.toolCallId, messages: ctx.messages ?? [], context: ctx.toolsContext?.[call.toolName] }) : na;
    return need ? "user-approval" : undefined;
  }
  async function fallback(call, ctx) {
    const f = opts.fallback;
    if (f === undefined || f === null) return undefined;
    if (typeof f === "function") return f(ctx);
    const r = Object.hasOwn(f, call.toolName) ? f[call.toolName] : undefined;
    return typeof r === "function" ? r(call.input, { toolCallId: call.toolCallId, messages: ctx.messages ?? [], toolContext: ctx.toolsContext?.[call.toolName], runtimeContext: ctx.runtimeContext }) : r;
  }

  /** GenericToolApprovalFunction: pass it as toolApproval. */
  const approval = async (ctx) => {
    const call = ctx?.toolCall || {};
    const { toolName, toolCallId, input } = call;
    let status;
    if (pay.has(toolName)) {
      status = await judgePayment(toolName, toolCallId, input);
    } else {
      const named = shell.has(toolName);
      const pick = shell.get(toolName);
      let lines = [];
      try {
        if (named) lines = typeof pick === "function" ? [].concat((await pick(input)) ?? []).filter((l) => typeof l === "string") : commandsOf(input);
        else if (detect && typeof input?.command === "string") lines = [input.command];
      } catch (e) {
        return unchecked(`alalanet install_check: NOT CHECKED — the command could not be read from ${shown(toolName, 80)}'s input (${shown(e?.message || e, 200)}). Run only if the user confirms.`);
      }
      // a named shell tool whose input has no command line asks, except a bare restart of the shell (Anthropic's bash)
      if (named && lines.length === 0 && input !== undefined && !(input?.restart === true && input.command === undefined)) {
        status = unchecked(`alalanet install_check: NOT CHECKED — no command line found in ${shown(toolName, 80)}'s input. Run only if the user confirms.`);
      } else if (lines.length) {
        status = await judgeCommands(toolName, toolCallId, lines);
      }
    }
    if (kind(status) === "denied") return status;
    status = stricter(status, await own(call, ctx));
    return stricter(status, await fallback(call, ctx));
  };
  return approval;
}
