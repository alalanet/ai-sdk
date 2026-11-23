// A small mutation run: each mutant breaks one path the package exists for, in a copy of the package, and the
// tests must fail on it. A mutant the tests let through, or one whose code is no longer there, fails the run.
//   node test/mutants.mjs
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const mutants = [
  // the block path
  { name: "block: a deny from alalanet becomes an ask", file: "approval.js", from: 'if (v.decision === "deny") st = { type: "denied", reason: v.reason };', to: 'if (v.decision === "deny") st = { type: "user-approval", reason: v.reason };' },
  { name: "block: a deny from alalanet is ignored", file: "core.js", from: 'if (decision === "deny") return { decision: "deny", reason, checked: true };', to: 'if (decision === "deny") return { decision: "allow", reason, checked: true };' },
  { name: "block: a blocked payment runs", file: "approval.js", from: 'return { type: "denied", reason: `alalanet preflight: BLOCK', to: 'return { type: "not-applicable", reason: `alalanet preflight: BLOCK' },
  // the fail-closed path
  { name: "fail-closed: an unreachable alalanet lets the command run", file: "core.js", from: 'return notChecked("unreachable", `alalanet could not be reached', to: 'return { decision: "allow", checked: true, reason: "" } || (`' },
  { name: "fail-closed: an error status lets the command run", file: "core.js", from: 'if (res.status !== 200) return notChecked("unreachable", `alalanet answered HTTP ${res.status}`);', to: 'if (res.status !== 200) return { decision: "allow", reason: "", checked: true };' },
  { name: "fail-closed: an unchecked command runs", file: "approval.js", from: 'else if (v.decision === "ask") st = v.checked ? hold(v.reason) : unchecked(v.reason);', to: 'else if (v.decision === "ask") st = v.checked ? hold(v.reason) : undefined;' },
  { name: "fail-closed: an unanswered preflight lets the payment run", file: "approval.js", from: 'return unchecked(`alalanet preflight: NOT CHECKED ${shown(p.url, 300)}', to: 'return undefined && (`${shown(p.url, 300)}' },
  // the approval path
  { name: "approval: a hold runs without asking", file: "approval.js", from: 'return onHold === "deny" ? { type: "denied", reason } : { type: "user-approval", reason };', to: 'return onHold === "deny" ? { type: "denied", reason } : undefined;' },
  { name: "approval: the tool's own needsApproval is dropped", file: "approval.js", from: "status = stricter(status, await own(call, ctx));", to: "" },
  { name: "approval: the strictest status no longer wins", file: "approval.js", from: "return RANK[kind(b)] > RANK[kind(a)] ? b : a;", to: "return b === undefined ? a : b;" },
  // round 2, F1: the filter
  { name: "F1: any program counts as read-only", file: "filter.js", from: "if (!READ_ONLY.has(cmd)) return false;", to: "" },
  { name: "F1: $, backticks, redirections and line breaks no longer send", file: "filter.js", from: "if (UNSURE.test(text)) return false;", to: "" },
  { name: "F1: the filter is back to an install word list", file: "approval.js", from: 'opts.prefilter === false ? () => true : mustSend;', to: 'opts.prefilter === false ? () => true : (l) => /\\b(npm|npx|pip|uvx)\\b/.test(l);' },
  // F2: arguments, shell scripts, stdin
  { name: "F2: args are not appended to the program", file: "approval.js", from: "argvLine([v, ...args]);", to: "lines.push(v);" },
  { name: "F2: a shell's -c script is not sent", file: "approval.js", from: "if (typeof sh.script === \"string\" && sh.script.trim() !== \"\") textLine(sh.script, depth + 1);", to: "if (typeof sh.script === \"string\" && sh.script.trim() !== \"\") void 0;" },
  { name: "F2: stdin (and the other text fields) is not sent", file: "approval.js", from: 'if (typeof src[f] === "string") textLine(src[f]);', to: 'if (typeof src[f] === "string") void 0;' },
  // F3: what cannot be read
  { name: "F3: an unread part of the call is dropped", file: "approval.js", from: "if (unread.length) {", to: "if (false) {" },
  // F4: silence
  { name: "F4: a browser or an extension is not detected", file: "core.js", from: "if (browserLike()) return notChecked(", to: "if (false) return notChecked(" },
  { name: "F4: requireSilenceMark is ignored", file: "core.js", from: "if (s.requireSilenceMark) return", to: "if (false) return" },
  { name: "the hook's first name is not asked after a 404", file: "core.js", from: "if (res.status === 404) ({ res, text }", to: "if (false) ({ res, text }" },
  { name: "F4: the mark is not required by default", file: "core.js", from: "export const REQUIRE_SILENCE_MARK = true;", to: "export const REQUIRE_SILENCE_MARK = false;" },
  { name: "F4: the off switch is not read", file: "core.js", from: "markEnv !== \"\" ? !OFF.has(markEnv) : REQUIRE_SILENCE_MARK", to: "REQUIRE_SILENCE_MARK" },
  { name: "F4: any silence mark allows", file: "core.js", from: "if (mark.trim().toLowerCase() === SILENCE_OK) return", to: "if (true) return" },
  // F6: names and fields
  { name: "F6: shell names compare with case and _", file: "approval.js", from: 'export const normalName = (n) => String(n ?? "").toLowerCase().replace(/[-_]/g, "");', to: 'export const normalName = (n) => String(n ?? "");' },
  { name: "F6: only input.command is detected", file: "approval.js", from: "else if (named || (detect && hasCommandField(input, toolName)))", to: 'else if (named || (detect && typeof input?.command === "string"))' },
  // F9: preflight's shapes
  {
    name: "F9: preflight reads any shape and lets a failure through",
    file: "core.js",
    edits: [
      ["if (!Array.isArray(options) || !options.every((o) => o && typeof o === \"object\" && !Array.isArray(o) && list(o.reasons)) || !list(json.reasons)) {", "if (false) {"],
      ['return { decision: "unchecked", reasons: [], error: "bad_answer", hint: shown(e?.message || e, 200) };', 'return { decision: "allow", reasons: [] };'],
    ],
  },
  // F10: the answer's size
  { name: "F10: a stream answer is read whole", file: "core.js", from: "if (n > ANSWER_MAX) {", to: "if (false) {" },
  { name: "F10: a text answer is read whole", file: "core.js", from: 'if (t.length > ANSWER_MAX) throw new AnswerTooLarge("alalanet\'s answer is too large to read");', to: "" },
  // round 3
  { name: "R2-1: the shell-joined line of a program and its args is not sent", file: "approval.js", from: "if (plain !== quoted) textLine(plain);", to: "" },
  { name: "R2-2: process tools are not named", file: "approval.js", from: "const named = shell.has(toolName) || processTools.has(toolName);", to: "const named = shell.has(toolName);" },
  { name: "R2-2: input, chars, data, text and keys are not read", file: "approval.js", from: "for (const f of TEXT_FIELDS) {", to: 'for (const f of ["stdin"]) {' },
  { name: "R2-2: a process field with text is not detected", file: "approval.js", from: "if (!TEXT_FIELDS.some((f) => given(src[f]))) continue;", to: "if (true) continue;" },
  { name: "R2-2: file, program and executable are not programs", file: "approval.js", from: "for (const f of [...LINE_FIELDS, ...PROGRAM_FIELDS]) {", to: "for (const f of LINE_FIELDS) {" },
  { name: "R2-3: only some -EncodedCommand spellings are encoded", file: "approval.js", from: 'if ("encodedcommand".startsWith(n) || n === "ec" || n.startsWith("encodeda")) return { kind: "encoded" };', to: 'if (n === "e" || n === "ec" || n === "enc" || n === "encodedcommand") return { kind: "encoded" };' },
  { name: "R2-3: only -c and -command are -Command", file: "approval.js", from: 'if ("command".startsWith(n)) return { kind: "command" };', to: 'if (n === "c" || n === "command") return { kind: "command" };' },
  { name: "R2-3: a one-command line's shell script is not read", file: "approval.js", from: "shellOf(argv, depth);", to: "" },
  { name: "R2-4: Node, Deno and Bun are not known as servers", file: "core.js", from: "if (g.process?.versions?.node || g.Deno?.version || g.Bun?.version) return false;", to: "" },
  { name: "R2-4: workerd is not known as a server", file: "core.js", from: 'if (g.navigator?.userAgent === "Cloudflare-Workers") return false;', to: "" },
  { name: "R2-4: an Electron renderer is taken for a server", file: "core.js", from: 'g.process?.type === "renderer" || ', to: "" },
  { name: "R2-5: grep, rg and git are read-only again", file: "filter.js", from: 'const READ_ONLY = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf"]);', to: 'const READ_ONLY = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf", "grep", "rg", "git"]);' },
  { name: "R2-5: printf -v stays local", file: "filter.js", from: 'if (cmd === "printf" && args.some((a) => a.startsWith("-v"))) return false;', to: "" },
  // round 4
  { name: "R3-1: Windows PowerShell's positional words are not its script", file: "approval.js", from: 'return p === "powershell" ? { script: argv.slice(i).join(" ") } : { fileUnread: true };', to: "return { file: true };" },
  { name: "R3-1: pwsh's positional script file does not ask", file: "approval.js", from: 'else if (sh?.fileUnread) unread.push("a PowerShell script file, which is not read");', to: "" },
  { name: "R3-1: a valued parameter's value is not skipped", file: "approval.js", from: 'if (k.kind === "valued") i++;', to: "" },
  { name: "R3-2: cmd's switch glued to the script is not read", file: "approval.js", from: "if (/^\\/[ckr]/.test(low)) {", to: 'if (low === "/c" || low === "/k" || low === "/r") {' },
  { name: "R3-3: any tool with a session and a text is a shell", file: "approval.js", from: "if (PROCESS_FIELDS.some((f) => given(src[f])) && (hasWord(words, PROCESS_WORDS) || PROGRAM_FIELDS.some((f) => line(src[f])))) return true;", to: "if (PROCESS_FIELDS.some((f) => given(src[f]))) return true;" },
  { name: "R3-4: a terminal's text without a process field is not read", file: "approval.js", from: "if (hasWord(words, TERMINAL_WORDS)) return true;", to: "" },
  { name: "R3-4: terminalId is not a process field", file: "approval.js", from: "const STRONG_FIELDS = [\"pid\", \"process_id\", \"processId\", \"terminal_id\", \"terminalId\"];", to: "const STRONG_FIELDS = [\"pid\", \"process_id\", \"processId\"];" },
  { name: "R3-5: a Node or workerd claim wins over extension marks", file: "core.js", from: 'if (g.process?.type === "renderer" || Boolean(g.chrome?.runtime?.id) || Boolean(g.browser?.runtime?.id)) return true;', to: 'if (g.process?.type === "renderer") return true;' },
  { name: "R3-5: a service or dedicated worker is not detected", file: "core.js", from: 'if (typeof g.registration !== "undefined" || typeof g.importScripts === "function") return true;', to: "" },
  { name: "R3-1b: bash's valued options are not skipped", file: "approval.js", from: "if (SH_VALUED.has(a)) {", to: "if (false) {" },
  { name: "R3-7: a network share stays local", file: "filter.js", from: 'if (args.some((a) => a.startsWith("//"))) return false;', to: "" },
  // round 5
  { name: "R4-1: a compound line's parts are not read", file: "approval.js", from: "const parts = commandParts(line) ?? [];", to: "const parts = [line];" },
  { name: "R4-1: wrappers are not skipped", file: "approval.js", from: "let argv = posix ? unwrap(posix, []) : [];", to: "let argv = posix ?? [];" },
  { name: "R4-1: VAR=x words are not skipped", file: "filter.js", from: "if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || KEYWORDS.has(w)) {", to: "if (KEYWORDS.has(w)) {" },
  { name: "R4-1: timeout's duration is taken for the program", file: "filter.js", from: 'if (p === "timeout" && i < words.length) i++; // the duration', to: "" },
  { name: "R4-1: a wrapper's valued option is not skipped with its value", file: "filter.js", from: "i += valued.includes(o) ? 2 : 1;", to: "i += 1;" },
  { name: "R4-1: env -S is not read", file: "filter.js", from: "if (i + 1 < words.length) lines.push(words[i + 1]);", to: "" },
  { name: "R4-1: a Windows path is unescaped as POSIX", file: "approval.js", from: "if (lit.length && WINDOWS_SHELLS.has(program(lit[0]))) argv = lit;", to: "" },
  { name: "R4-1: an extracted script is not read again", file: "approval.js", from: "textLine(sh.script, depth + 1)", to: "add(sh.script)" },
  { name: "R4-1: nesting is not bounded by an ask", file: "approval.js", from: "if (depth > MAX_DEPTH) {", to: "if (false) {" },
  { name: "R4-2: names are matched as substrings", file: "approval.js", from: "return words.some((w) => set.has(w)) ||", to: 'return (set === PROCESS_WORDS ? /process|terminal|shell|stdin|pty|tmux|exec|command|run/.test(words.join("")) : words.some((w) => set.has(w))) ||' },
  { name: "R4-2: command and keys as the last word do not count", file: "approval.js", from: "(words.length > 0 && LAST_WORDS.has(words[words.length - 1]) && set === PROCESS_WORDS)", to: "false" },
  { name: "R4-3: a pid or a terminal id with text needs a name", file: "approval.js", from: "if (STRONG_FIELDS.some((f) => given(src[f]))) return true;", to: "" },
  { name: "R4-3: repl, console and screen are not process words", file: "approval.js", from: 'const TERMINAL_WORDS = new Set(["terminal", "stdin", "shell", "pty", "tty", "console", "tmux", "screen", "bash", "repl"]);', to: 'const TERMINAL_WORDS = new Set(["terminal", "stdin", "shell", "pty", "tmux"]);' },
];

let bad = 0;
for (const m of mutants) {
  const dir = mkdtempSync(join(tmpdir(), "alalanet-ai-sdk-mutant-"));
  for (const f of ["index.js", "approval.js", "core.js", "filter.js", "tools.js", "package.json", "test"]) cpSync(join(root, f), join(dir, f), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  let src = readFileSync(join(dir, m.file), "utf8");
  const edits = m.edits || [[m.from, m.to]];
  if (edits.some(([from]) => src.split(from).length !== 2)) {
    console.log(`MISSING  ${m.name}: its code is not in ${m.file} exactly once`);
    bad++;
    continue;
  }
  for (const [from, to] of edits) src = src.replace(from, () => to);
  writeFileSync(join(dir, m.file), src);
  // a mutant that does not parse would be "killed" by any test run: it must be valid code
  if (spawnSync(process.execPath, ["--check", join(dir, m.file)]).status !== 0) {
    console.log(`INVALID  ${m.name}: the mutated ${m.file} does not parse`);
    bad++;
    continue;
  }
  const tests = readdirSync(join(dir, "test")).filter((f) => f.endsWith(".test.js")).map((f) => join("test", f));
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=dot", ...tests], { cwd: dir, encoding: "utf8", timeout: 120000 });
  const killed = r.status !== 0;
  console.log(`${killed ? "killed  " : "SURVIVED"} ${m.name}${killed ? "" : " (the tests passed with it)"}`);
  if (!killed) bad++;
}
console.log(`${mutants.length - bad} of ${mutants.length} mutants killed`);
process.exit(bad ? 1 : 0);
