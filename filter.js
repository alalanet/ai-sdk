// Which shell command lines stay in your process. Every line goes to alalanet except one that only prints:
// a copy of alalanet's install reader on this side would always lag the server's, and a line it missed would run
// with no verdict and no question. So the test here is the other way round: a short list of programs that only read
// the files they are given and print, read strictly; anything else, or anything this reader is not sure of, is sent.

// Programs that only read and print what they are given. Not git (git status, diff and log run what the
// repository's config names: core.fsmonitor, diff.external, a textconv driver), not rg or grep (rg runs programs
// for --pre, --hostname-bin and -z, and a file named --pre=sh in a glob becomes such an option).
const READ_ONLY = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf"]);

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
  if (!READ_ONLY.has(cmd)) return false;
  if (cmd === "printf" && args.some((a) => a.startsWith("-v"))) return false; // printf -v NAME sets a variable (PATH)
  if (args.some((a) => a.startsWith("//"))) return false; // //host/share: on Windows, an SMB connection with the user's credentials
  return true;
}

/**
 * true when the line stays in your process: every simple command in it (split at ;, &&, ||, | and &) is one of
 * ls, pwd, cat, head, tail, wc, echo or printf (not printf -v), with no argument that starts with // (a network
 * share on Windows), with plain quoting, and the line has no $,
 * backtick, redirection, parenthesis, brace, backslash, !, line break, tab or non-ASCII character. An empty line
 * runs nothing and stays too.
 */
export function isReadOnly(line) {
  const text = String(line ?? "");
  if (text.trim() === "") return true;
  if (UNSURE.test(text)) return false;
  const parts = split(text);
  if (!parts) return false;
  for (const p of parts) {
    if (p.trim() === "") continue;
    const ws = words(p);
    if (!ws || !readOnlyCommand(ws)) return false;
  }
  return true;
}

/** The words of a line that is one simple command with plain quoting (no operator, no expansion), or null. */
export function simpleWords(line) {
  const text = String(line ?? "");
  if (UNSURE.test(text)) return null;
  const parts = split(text);
  if (!parts || parts.length !== 1) return null;
  return words(parts[0]);
}

// The line split at ;, &, | outside quotes (a quoted | or ; is an argument); null with an unbalanced quote.
function split(text) {
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
  if (q) return null;
  parts.push(cur);
  return parts;
}

/** true when the line is sent to alalanet: everything but isReadOnly. */
export function mustSend(line) {
  return !isReadOnly(line);
}
