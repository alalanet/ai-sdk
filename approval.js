// alalanetApproval: the AI SDK's toolApproval (ToolLoopAgent, generateText, streamText) that asks alalanet before a
// shell command or a payment runs. block -> denied with alalanet's reasons; hold -> the user decides; alalanet could
// not check -> the user decides (or denied with onUnchecked: "deny"), never a silent run.

import { checkCommand, preflight, settings, shown } from "./core.js";
import { mustSend } from "./filter.js";

// Tool names treated as a shell by default, compared without case, "_" or "-" (run_command, runCommand and
// RunCommand are one name); any tool whose input has a string command, cmd, commandLine, command_line or script
// counts as well.
export const DEFAULT_SHELL_TOOLS = [
  "bash", "shell", "sh", "zsh", "powershell", "pwsh", "terminal", "exec", "execute", "run", "command", "cmd",
  "runCommand", "runShell", "runBash", "executeCommand", "execCommand", "shellCommand", "localShell",
  "runTerminalCommand", "runTerminalCmd", "runInTerminal", "sandbox", "codeExecution",
];
export const normalName = (n) => String(n ?? "").toLowerCase().replace(/[-_]/g, "");

// Fields that hold a whole command line, a program with its arguments, or a script fed to the program.
const LINE_FIELDS = ["command", "cmd", "commandLine", "command_line", "script"];
const ARG_FIELDS = ["args", "argv", "arguments"];
// Programs whose -c (or /c, -Command) argument is a script; with no such argument they read the script from stdin.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "busybox", "pwsh", "powershell", "cmd"]);

const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

function quote(a) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;
}

function program(word) {
  return word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).toLowerCase().replace(/\.exe$/, "");
}

// What a shell's argv runs: { script } for bash -c '...' (and -lc, -ec), cmd /c ..., pwsh -Command ...;
// { encoded } for pwsh -EncodedCommand; { file } for a script file; { none } for a shell that reads stdin;
// undefined when argv[0] is not a shell.
function shellScript(argv) {
  const p = program(argv[0]);
  if (!SHELLS.has(p)) return undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const low = a.toLowerCase();
    if (p === "cmd") {
      if (low === "/c" || low === "/k" || low === "/r") return { script: argv.slice(i + 1).join(" ") };
      continue;
    }
    if (p === "pwsh" || p === "powershell") {
      if (/^-(e|ec|en|enc|enco|encodedcommand)$/.test(low)) return { encoded: true };
      if (/^-(c|command)$/.test(low)) return { script: argv.slice(i + 1).join(" ") };
      if (/^-(f|file)$/.test(low)) return { file: true };
      continue;
    }
    if (p === "busybox" && i === 1 && SHELLS.has(low)) continue; // busybox sh -c ...
    if (a === "--") return { file: true };
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) return { script: argv[i + 1] };
    if (!a.startsWith("-") && !a.startsWith("+")) return { file: true }; // bash install.sh: the file is not read here
  }
  return { none: true };
}

/**
 * The command lines in a shell tool's input, and what could not be read. Read are, in the input and under its
 * action (OpenAI's shell and local_shell): command, cmd, commandLine, command_line and script (a line, or argv as a
 * list), with args, argv or arguments appended to the program, POSIX-quoted ({cmd: "npm", args: ["install", "x"]}
 * is "npm install x"); commands (a list of lines or argv lists); and stdin, sent as a line of its own. The script
 * of a shell argv (bash -c, cmd /c, pwsh -Command) is sent as a line too. A field of another type, a list entry that
 * is not a command, a shell -c without its script, a PowerShell -EncodedCommand: unread, and the call asks.
 */
export function readCommands(input) {
  const lines = [];
  const unread = [];
  const argvLine = (argv) => {
    lines.push(argv.map(quote).join(" "));
    const sh = shellScript(argv);
    if (sh?.encoded) unread.push("an encoded PowerShell command");
    else if (sh && "script" in sh) {
      if (typeof sh.script === "string" && sh.script.trim() !== "") lines.push(sh.script);
      else unread.push("a shell's -c without its script");
    }
  };
  for (const src of [input, input?.action]) {
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    let args;
    for (const f of ARG_FIELDS) {
      if (src[f] === undefined || src[f] === null) continue;
      if (isStrings(src[f])) args = [...(args ?? []), ...src[f]];
      else unread.push(`${f} is not a list of strings`);
    }
    let used = !args;
    for (const f of LINE_FIELDS) {
      const v = src[f];
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && !used && (f === "command" || f === "cmd")) {
        argvLine([v, ...args]);
        used = true;
      } else if (typeof v === "string") lines.push(v);
      else if (isStrings(v) && v.length) {
        argvLine(used ? v : [...v, ...args]);
        used = true;
      } else unread.push(`${f} is not a command line`);
    }
    if (!used) unread.push("arguments without a program to run");
    if (src.commands !== undefined && src.commands !== null) {
      if (!Array.isArray(src.commands)) unread.push("commands is not a list");
      else
        for (const c of src.commands) {
          if (typeof c === "string") lines.push(c);
          else if (isStrings(c) && c.length) argvLine(c);
          else unread.push("an entry of commands is not a command line");
        }
    }
    if (src.stdin !== undefined && src.stdin !== null) {
      if (typeof src.stdin === "string") lines.push(src.stdin);
      else unread.push("stdin is not text");
    }
  }
  return { lines, unread };
}

/** The command lines readCommands finds (what it could not read makes the approval ask). */
export function commandsOf(input) {
  return readCommands(input).lines;
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

// A tool not named as a shell counts as one when its input has a command line in one of these fields.
function hasCommandField(input) {
  if (!input || typeof input !== "object") return false;
  return LINE_FIELDS.some((f) => typeof input[f] === "string" || isStrings(input[f])) || typeof input.action?.command === "string" || isStrings(input.action?.command) || isStrings(input.action?.commands);
}

// A list replaces the defaults; a map of extractors adds to them. Names compare without case, "_" or "-".
function nameSet(list, defaults) {
  const def = new Set(defaults.map(normalName));
  if (list === undefined || list === null) return { has: (n) => def.has(normalName(n)), get: () => undefined };
  if (Array.isArray(list)) {
    const set = new Set(list.map(normalName));
    return { has: (n) => set.has(normalName(n)), get: () => undefined };
  }
  const map = new Map(Object.keys(list).map((k) => [normalName(k), list[k]]));
  return { has: (n) => map.has(normalName(n)) || def.has(normalName(n)), get: (n) => map.get(normalName(n)) };
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
  // which lines are sent: by default all but the plainly read-only (isReadOnly); false: every line; a function
  // (line) => boolean: your own test, true to send
  const sends = typeof opts.prefilter === "function" ? opts.prefilter : opts.prefilter === false ? () => true : mustSend;
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
      let send = true;
      try {
        send = (await sends(line)) !== false; // only a plain false keeps a line here; an error sends it
      } catch {}
      if (!send) continue;
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
      let unread = [];
      try {
        if (named && typeof pick === "function") lines = [].concat((await pick(input)) ?? []).filter((l) => typeof l === "string");
        else if (named || (detect && hasCommandField(input))) ({ lines, unread } = readCommands(input));
      } catch (e) {
        return unchecked(`alalanet install_check: NOT CHECKED — the command could not be read from ${shown(toolName, 80)}'s input (${shown(e?.message || e, 200)}). Run only if the user confirms.`);
      }
      if (unread.length) {
        // a part of the call that may run something and could not be read: the whole call asks
        status = unchecked(`alalanet install_check: NOT CHECKED — ${shown(toolName, 80)}'s input could not be read whole (${shown(unread.join("; "), 300)}). Run only if the user confirms.`);
      } else if (named && lines.length === 0 && input !== undefined && !(input?.restart === true && input.command === undefined)) {
        // a named shell tool whose input has no command line asks, except a bare restart of the shell (Anthropic's bash)
        status = unchecked(`alalanet install_check: NOT CHECKED — no command line found in ${shown(toolName, 80)}'s input. Run only if the user confirms.`);
      }
      if (lines.length) status = stricter(status, await judgeCommands(toolName, toolCallId, lines));
    }
    if (kind(status) === "denied") return status;
    status = stricter(status, await own(call, ctx));
    return stricter(status, await fallback(call, ctx));
  };
  return approval;
}
