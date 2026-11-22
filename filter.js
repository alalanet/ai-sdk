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

// --- reading a command line to unpack it (the approval's reader; nothing here decides what stays local) ---

/**
 * The simple commands of a line: split at ;, &, |, (, ) and line breaks outside quotes (&& and || too). With
 * literal (a PowerShell or cmd line) a backslash is a path character; otherwise it escapes the next one. null with
 * an unbalanced quote.
 */
export function commandParts(text, literal = false) {
  const parts = [];
  let cur = "";
  let q = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = "";
      else if (q === '"' && !literal && c === "\\" && i + 1 < text.length) {
        cur += c + text[++i];
        continue;
      }
      cur += c;
    } else if (!literal && c === "\\" && i + 1 < text.length) {
      cur += c + text[++i];
    } else if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (";&|()\n\r".includes(c)) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (q) return null;
  parts.push(cur);
  return parts.filter((p) => p.trim() !== "");
}

/**
 * The words of one simple command as the shell passes them: quotes taken out, and with literal false a backslash
 * escaping the next character (POSIX); with literal true backslashes stay (C:\Windows\...\powershell.exe). null
 * with an unbalanced quote.
 */
export function commandWords(text, literal = false) {
  const out = [];
  let cur = null;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (cur !== null) out.push(cur);
      cur = null;
      i++;
      continue;
    }
    cur ??= "";
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) return null;
      cur += text.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (!literal && text[j] === "\\" && j + 1 < text.length && '$`"\\\n'.includes(text[j + 1])) {
          if (text[j + 1] !== "\n") cur += text[j + 1];
          j += 2;
        } else cur += text[j++];
      }
      if (j >= text.length) return null;
      i = j + 1;
    } else if (c === "\\" && !literal) {
      if (i + 1 < text.length && text[i + 1] !== "\n") cur += text[i + 1];
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

// Programs that run the rest of their words as a command, and their options that take a value.
const WRAPPERS = {
  env: ["-u", "--unset", "-C", "--chdir"],
  sudo: ["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout"],
  doas: ["-u", "-C"],
  timeout: ["-k", "--kill-after", "-s", "--signal"],
  nohup: [],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "--class", "-n", "--classdata", "-p", "--pid"],
  command: [],
  builtin: [],
  exec: ["-a"],
  stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
  xargs: ["-I", "-i", "-L", "-l", "-n", "--max-args", "-P", "--max-procs", "-d", "--delimiter", "-E", "-e", "-s", "--max-chars", "-a", "--arg-file"],
  time: ["-f", "--format", "-o", "--output"],
  nocorrect: [],
  noglob: [],
};
// words before a command that are not the program: shell keywords, a subshell's or group's brace
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "coproc"]);

function base(word) {
  return word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).toLowerCase().replace(/\.exe$/, "");
}

/**
 * The words from the program on: VAR=x assignments, shell keywords and wrappers (env, sudo, doas, timeout N,
 * nohup, nice, ionice, command, builtin, exec, stdbuf, xargs, time) with their options are skipped. lines gets the
 * command line of env -S, which env splits and runs itself.
 */
export function unwrap(words, lines = []) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || KEYWORDS.has(w)) {
      i++;
      continue;
    }
    const p = base(w);
    if (!Object.hasOwn(WRAPPERS, p)) break;
    const valued = WRAPPERS[p];
    i++;
    while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
      const o = words[i];
      if (o === "--") {
        i++;
        break;
      }
      if (p === "env" && (o === "-S" || o === "--split-string")) {
        if (i + 1 < words.length) lines.push(words[i + 1]);
        i += 2;
        continue;
      }
      if (p === "env" && o.startsWith("-S") && o.length > 2) lines.push(o.slice(2));
      i += valued.includes(o) ? 2 : 1;
    }
    if (p === "timeout" && i < words.length) i++; // the duration
  }
  return words.slice(i);
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
