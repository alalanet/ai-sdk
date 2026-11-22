// Which shell command lines stay in your process. Every line goes to alalanet except one that is plainly read-only:
// a copy of alalanet's install reader on this side would always lag the server's, and a line it missed would run
// with no verdict and no question. So the test here is the other way round: a short list of commands that cannot
// install or run anything, read strictly; anything else, or anything this reader is not sure of, is sent.

// Programs that only read and print. git only with these subcommands, and rg without options that run a program.
const READ_ONLY = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf", "grep", "egrep", "fgrep", "rg"]);
const GIT_READ = new Set(["status", "log", "diff", "show"]);
// git options that run a program (an external diff, a text converter, a pager) or write a file
const GIT_RUNS = /^(--ext-diff|--textconv|--output(=|$)|-c$|--exec-path|--paginate|--config-env)/;
const RG_RUNS = /^(--pre(-glob)?(=|$)|-z$|--search-zip$)/;

// Characters that make the shell build, expand or redirect: a variable or substitution ($, backticks), a
// redirection (< >), a subshell or a group, a line break or a backslash (an escape or a line continuation), history
// expansion, and anything outside printable ASCII (a tab included).
const UNSURE = /[$`<>(){}\\!\n\r]|[^ -~]/;

// The words of one simple command, with plain single and double quotes taken out; null when the quoting is not plain.
function words(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s"']+)|(["'])/g;
  let m;
  let cur = null;
  let last = 0;
  while ((m = re.exec(cmd))) {
    if (m[4]) return null; // an unbalanced quote
    const gap = cmd.slice(last, m.index);
    if (gap.trim() !== "") return null;
    if (gap.length > 0 && cur !== null) {
      out.push(cur);
      cur = null;
    }
    cur = (cur ?? "") + (m[1] ?? m[2] ?? m[3]);
    last = re.lastIndex;
  }
  if (cmd.slice(last).trim() !== "") return null;
  if (cur !== null) out.push(cur);
  return out;
}

function readOnlyCommand(ws) {
  if (ws.length === 0) return false;
  const [cmd, ...args] = ws;
  if (cmd === "git") {
    if (!GIT_READ.has(args[0])) return false; // git's own options before the subcommand (-c, -C, --exec-path) included
    return !args.slice(1).some((a) => GIT_RUNS.test(a));
  }
  if (!READ_ONLY.has(cmd)) return false;
  if (cmd === "rg") return !args.some((a) => RG_RUNS.test(a));
  return true;
}

/**
 * true when the line stays in your process: every simple command in it (split at ;, &&, ||, | and &) is one of
 * ls, pwd, cat, head, tail, wc, echo, printf, grep, egrep, fgrep, rg (without --pre or -z), or git status / log /
 * diff / show (without options that run a program or write a file), with plain quoting, and the line has no $,
 * backtick, redirection, parenthesis, brace, backslash, !, line break, tab or non-ASCII character. An empty line
 * runs nothing and stays too.
 */
export function isReadOnly(line) {
  const text = String(line ?? "");
  if (text.trim() === "") return true;
  if (UNSURE.test(text)) return false;
  // split at the operators outside quotes: a quoted | or ; is an argument
  const parts = [];
  let cur = "";
  let q = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = "";
      cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ";" || c === "|" || c === "&") {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (q) return false;
  parts.push(cur);
  for (const p of parts) {
    if (p.trim() === "") continue;
    const ws = words(p);
    if (!ws || !readOnlyCommand(ws)) return false;
  }
  return true;
}

/** true when the line is sent to alalanet: everything but isReadOnly. */
export function mustSend(line) {
  return !isReadOnly(line);
}
