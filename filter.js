// Which shell command lines go to alalanet. alalanet's hook reads only what a line installs or runs (packages,
// repositories, MCP servers, extensions, downloaded scripts) and stays silent on the rest, so a line that names
// none of the programs below is not sent at all: it never leaves your process. The test is on the text of the whole
// line, as the alalanet guard plugin for Cursor makes it, and leans to sending: a line that only mentions one of the
// programs is sent too.

// Package managers and installers alalanet's install reader knows.
const WATCHED = new Set([
  "npm", "pnpm", "yarn", "bun", "npx", "bunx", "pnpx",
  "pip", "pip3", "pipx", "uv", "uvx", "deno", "go",
  "skills", "clawhub", "openclaw",
]);
// claude, codex or gemini followed by mcp (claude mcp add ...)
const MCP_CLIS = new Set(["claude", "codex", "gemini"]);
// a download that a runner may execute: curl ... | sh, irm ... | iex, bash -c "$(curl ...)"
const DOWNLOADERS = new Set(["curl", "wget", "irm", "iwr", "invoke-webrequest", "invoke-restmethod", "fetch", "aria2c"]);
const RUNNERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "source", ".", "eval",
  "iex", "invoke-expression", "pwsh", "powershell", "python", "python3", "node", "perl", "ruby",
]);

// A word as the shell would run it: without its folder and Windows extension, in lower case.
function command(word) {
  let w = word.toLowerCase();
  w = w.slice(Math.max(w.lastIndexOf("/"), w.lastIndexOf("\\")) + 1);
  return w.replace(/\.(cmd|exe|bat|ps1)$/, "");
}

function words(line) {
  return line.split(/[\s;&|()<>{}`]+/).filter(Boolean).map(command);
}

/**
 * true when the line is sent to alalanet: it names a watched program (also with quotes or backslashes between its
 * letters, as a path, or with .cmd, .exe, .bat or .ps1), claude / codex / gemini followed by mcp,
 * --install-extension or --add-mcp, a downloader together with a runner, or it builds a word at run time
 * (a variable, a command substitution, ANSI-C quoting, eval).
 */
export function mayInstall(line) {
  const raw = String(line ?? "");
  if (/[`]|\$[({'A-Za-z_]|\beval\b/.test(raw)) return true;
  // the same line twice: quotes and backslashes taken out (n"p"x, n\px), and backslashes read as folders (C:\x\npm.cmd)
  for (const text of [raw.replace(/["'\\]/g, ""), raw.replace(/["']/g, "")]) {
    if (/--install-extension|--add-mcp/i.test(text)) return true;
    const ws = words(text);
    let down = false;
    let run = false;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (WATCHED.has(w)) return true;
      if (MCP_CLIS.has(w) && ws.slice(i + 1).includes("mcp")) return true;
      if (DOWNLOADERS.has(w)) down = true;
      if (RUNNERS.has(w)) run = true;
    }
    if (down && run) return true;
  }
  return false;
}
