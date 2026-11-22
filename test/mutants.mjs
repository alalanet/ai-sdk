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
  { name: "F1: git's subcommand is not checked", file: "filter.js", from: "if (!GIT_READ.has(args[0])) return false;", to: "" },
  { name: "F1: the filter is back to an install word list", file: "approval.js", from: 'opts.prefilter === false ? () => true : mustSend;', to: 'opts.prefilter === false ? () => true : (l) => /\\b(npm|npx|pip|uvx)\\b/.test(l);' },
  // F2: arguments, shell scripts, stdin
  { name: "F2: args are not appended to the program", file: "approval.js", from: "argvLine([v, ...args]);", to: "lines.push(v);" },
  { name: "F2: a shell's -c script is not sent", file: "approval.js", from: 'if (typeof sh.script === "string" && sh.script.trim() !== "") lines.push(sh.script);', to: 'if (typeof sh.script === "string" && sh.script.trim() !== "") void 0;' },
  { name: "F2: stdin is not sent", file: "approval.js", from: 'if (typeof src.stdin === "string") lines.push(src.stdin);', to: 'if (typeof src.stdin === "string") void 0;' },
  // F3: what cannot be read
  { name: "F3: an unread part of the call is dropped", file: "approval.js", from: "if (unread.length) {", to: "if (false) {" },
  // F4: silence
  { name: "F4: a browser or an extension is not detected", file: "core.js", from: "if (browserLike()) return notChecked(", to: "if (false) return notChecked(" },
  { name: "F4: requireSilenceMark is ignored", file: "core.js", from: "if (REQUIRE_SILENCE_MARK || opts.requireSilenceMark) return", to: "if (REQUIRE_SILENCE_MARK) return" },
  { name: "F4: any silence mark allows", file: "core.js", from: "if (mark.trim().toLowerCase() === SILENCE_OK) return", to: "if (true) return" },
  // F6: names and fields
  { name: "F6: shell names compare with case and _", file: "approval.js", from: 'export const normalName = (n) => String(n ?? "").toLowerCase().replace(/[-_]/g, "");', to: 'export const normalName = (n) => String(n ?? "");' },
  { name: "F6: only input.command is detected", file: "approval.js", from: "else if (named || (detect && hasCommandField(input)))", to: 'else if (named || (detect && typeof input?.command === "string"))' },
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
