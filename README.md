# @alalanet/ai-sdk

```
npm i @alalanet/ai-sdk ai zod
```

Asks [alalanet](https://alalanet.com) **before** your [AI SDK](https://ai-sdk.dev) agent runs an install
command or pays an x402 endpoint. Without it, "check before you install" is a tool the model may skip.
With it, the check sits in the SDK's `toolApproval`, which the SDK runs before every tool call.

## In toolApproval (one line)

```js
import { ToolLoopAgent, tool, isStepCount } from "ai";
import { z } from "zod";
import { alalanetApproval } from "@alalanet/ai-sdk";

const agent = new ToolLoopAgent({
  model: "openai/gpt-5-mini",
  tools: {
    runCommand: tool({
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => sandbox.run(command),
    }),
  },
  toolApproval: alalanetApproval(),
  stopWhen: isStepCount(10),
});
```

`toolApproval` works the same in `generateText` and `streamText`. For each shell call the command line goes
to alalanet, which reads what it installs or runs (npm, PyPI and Go packages, `npx`/`uvx` launches, GitHub
repositories, skills, IDE extensions, MCP servers, `curl … | sh` scripts) and checks each one:

| alalanet says | the tool | the model or your UI gets |
|---|---|---|
| **block** (known malicious, typosquat, a name that does not exist, ...) | never runs | a denied tool result with the reason, `alalanet install_check: BLOCK. npm:… — osv_malicious. Do not install; tell the user.` |
| **hold** (new package, install scripts, maintainer change, a script alalanet does not read, ...) | waits for the user | a `tool-approval-request` with the reason in `approval.requestReason` (`onHold: "deny"` denies instead) |
| **not checked** (alalanet unreachable, timeout, an error status, daily limit, an answer it cannot read) | waits for the user | the same request, its reason starting `NOT CHECKED` (`onUnchecked: "deny"` denies instead) |
| nothing to say (no install in the line, or every install allowed) | runs as it would without the policy | |

A failure never lets a command run unasked. Answer a request as the AI SDK shows
([Tool Approvals](https://ai-sdk.dev/docs/agents/tool-approvals)): add a `tool-approval-response` and call
the agent again, or `addToolApprovalResponse` in `useChat`.

**When the message history comes from a client** (`useChat`, a serverless route that rebuilds the conversation from
the request), set `experimental_toolApprovalSecret`. Without it a client can send back an approval it made up, and
the SDK only evaluates the policy again: a call alalanet blocks stays denied while alalanet answers, but if that
second check is NOT CHECKED (alalanet unreachable, the daily limit used up) it asks, and the made-up approval runs
the call. With the secret, `ai` 7.0.178 and later do not sign a denied call, so it cannot be replayed. Without the
secret, `onUnchecked: "deny"` closes that gap at the cost of denying instead of asking when alalanet cannot check.

A `toolApproval` function replaces every tool's own `needsApproval` in the SDK. `alalanetApproval` reads
it back, so a tool marked `needsApproval` still asks. Your own policy goes in `fallback` (a per-tool map
or a function, as `toolApproval` takes them); of alalanet's status, the tool's and yours, the strictest wins:
denied, then user-approval, then approved.

```js
toolApproval: alalanetApproval({ fallback: { deleteFile: "user-approval", readFile: "approved" } }),
```

What it cannot see: provider-executed tools (they run at the provider, without the SDK's approval step), and
tools of subagents, which the SDK runs without `toolApproval`.

## Which tools count as a shell

- Tools named `bash`, `shell`, `sh`, `zsh`, `powershell`, `pwsh`, `terminal`, `exec`, `execute`, `run`,
  `command`, `cmd`, `runCommand`, `runShell`, `runBash`, `executeCommand`, `execCommand`, `shellCommand`,
  `localShell`, `runTerminalCommand`, `runTerminalCmd`, `runInTerminal`, `sandbox` or `codeExecution`
  (`DEFAULT_SHELL_TOOLS`), compared without case, `_` or `-`: `run_command`, `RunCommand` and `exec_command`
  are on the list.
- Tools that write into a running process: `interact_with_process` (Desktop Commander), `write_stdin`,
  `send_input`, `send_keys`, `write_to_process`; any tool whose input has a text field (below) with a process's
  or a terminal's id (`pid`, `process_id`, `processId`, `terminal_id`, `terminalId`); a tool with a session id
  (`session_id`, `sessionId`) and a text field when its name has a process word (`process`, `terminal`, `stdin`,
  `shell`, `pty`, `tty`, `console`, `tmux`, `screen`, `bash`, `exec`, `repl`, `run`, or `command` or `keys` as its
  last word) or the input names a program; and a tool whose name has a terminal word (`terminal`, `stdin`,
  `shell`, `pty`, `tty`, `console`, `tmux`, `screen`, `bash`, `repl`) with a text field alone, such as tmux
  send-keys. Names are compared word by word, split at `_`, `-` and camelCase: `rerun_report`,
  `executive_summary` and `command_palette_note` are not shells, and a chat or speech tool with a `session_id`
  and a `text` is not read. Other process tools go in `shellTools`. Typing into a terminal through a GUI tool (a `computer` tool's `type` action) is not seen unless the
  tool's name says terminal: name such a tool in `shellTools`.
- Any other tool whose input has a command line in `command`, `cmd`, `commandLine`, `command_line` or `script`,
  or a program in `file`, `program` or `executable` with `args` (`detectCommandInput: false` turns this off).
- Your own: `shellTools: { deploy: (input) => input.script }` (a function may return several lines; a map adds
  to the defaults), or a list of names that replaces them.

What is read from the input (and the same under `action`, as OpenAI's `shell` and `local_shell` send it):

- `command`, `cmd`, `commandLine`, `command_line`, `script`: a line, or argv as a list;
- `args`, `argv`, `arguments`: appended to the program (`command`, `cmd`, or `file`, `program`, `executable`), and
  checked twice: POSIX-quoted, as a tool that spawns argv runs it, and joined with spaces, as a tool that runs it
  through a shell does. `{ cmd: "npm", args: ["install", "x"] }` is `npm install x`;
  `{ command: "npm install", args: ["x"] }` is `'npm install' x` and `npm install x`. The strictest verdict wins;
- `commands`: a list of lines or argv lists, each checked;
- `stdin`, `input`, `chars`, `data`, `text`, `keys`: text fed to the program or to a running process, each checked
  as a line;
- every simple command of a line (split at `;`, `&&`, `||`, `|`, `&` and parentheses outside quotes), each as
  a line of its own, from its program on: `VAR=x` words, shell keywords and wrappers (`env`, `sudo`, `doas`,
  `timeout N`, `nohup`, `nice`, `ionice`, `command`, `builtin`, `exec`, `stdbuf`, `xargs`, `time`) with their
  options are skipped, and `env -S '…'` is read as a line. A PowerShell or cmd command keeps its backslashes, and
  a program is known by its file name without `.exe` (`C:\Windows\…\powershell.exe`);
- a shell's script, in argv or in any of those commands: `bash -c '…'` (and `-lc`), `cmd /c …` (also glued,
  `/cnpm …`, `/C"…"`, and `/k`, `/r`), PowerShell's `-Command` in any form PowerShell takes (`-c`, `-co`, …
  `-command`, `-CommandWithArgs`, with `-`, `--` or `/`), and Windows PowerShell's positional words, which it runs
  as `-Command` (`powershell -NoProfile npm i x`), are checked as the script too, and the script is read again
  the same way, so a script inside a script is unpacked (`sh -c 'pwsh -comm "npm i x"'`), up to four levels;
  deeper nesting, or more than 64 lines in one call, asks.

If any part cannot be read (a field of another type, a `commands` entry that is not a command, `bash -c` without
its script, PowerShell's `-EncodedCommand` in any prefix or form: `-e`, `-ec`, `-enc`, `-encod`, `/enc`,
`--encodedcommand`, and a script file pwsh 7 runs from its first positional word), the whole call asks the user. So does a named shell tool called with no command line.

**Which lines are sent.** Every line except one that only prints. A line stays in your process only when every
command in it (split at `;`, `&&`, `||`, `|`, `&`) is `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `echo` or `printf`
(not `printf -v`, which sets a variable), with no argument that starts with `//` (on Windows a network share,
which sends your credentials to its host), with plain quoting, and the line has no `$`, backtick, `<`, `>`,
parenthesis, brace, backslash, `!`, line break, tab or non-ASCII character. These programs only read the files they
are given and print; a line of them installs nothing and runs nothing else. `git`, `grep` and `rg` are sent: `git
status`, `git diff` and `git log` run what a repository's config names (`core.fsmonitor`, `diff.external`, a
textconv driver), and `rg` runs programs for `--pre`, `--hostname-bin` and `-z`, also from a file named `--pre=…`
that a glob expands. This side does not try to tell an install from other commands: alalanet's reader does that,
and a copy of it here would always lag the server. The test is `isReadOnly(line)` (`mustSend` is its opposite).
`prefilter: false` sends every line, including these; `prefilter: (line) => boolean` is your own test (true sends;
an error in it sends).

A line with nothing to check (no install in it) does not count against the daily checks, but every line sent
counts against the hook's request rate (per address: a burst of 120, then 2 a second). Past it, a command asks
(`NOT CHECKED`, retry in a few seconds).

## Payments

Name the tools that pay and how to read the URL from their input; the URL goes to alalanet's preflight
before the tool runs:

```js
toolApproval: alalanetApproval({
  paymentTools: { buyReport: (input) => ({ url: input.url }) }, // or ["buyReport"]: reads input.url
  maxUsdPerCall: 0.05,
}),
```

With the URL alone alalanet judges the terms it last observed there (`GET /v1/preflight`); return
`{ url, paymentRequired }` (the 402's `PAYMENT-REQUIRED` header or JSON body) to judge those terms
(`POST /v1/preflight`). block denies, hold asks (or denies, `onHold: "deny"`), an unanswered preflight asks.

The approval runs before the tool, so it cannot see the 402 the seller will send. Put
[`@alalanet/x402-guard`](https://github.com/alalanet/x402-guard) in the payment path inside the tool: it
checks the real 402 before any payment is signed and keeps your per-call, daily and per-seller budgets. This
package keeps no budget of its own.

```js
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { alalanetGuard } from "@alalanet/x402-guard";

const client = new x402Client(); // registerExactEvmScheme(client, { signer }) as usual
alalanetGuard(client, { maxUsdPerCall: 0.05, maxUsdPerDay: 2 });
const pay = wrapFetchWithPayment(fetch, client);

const buyReport = tool({
  inputSchema: z.object({ url: z.string().url() }),
  execute: async ({ url }) => (await pay(url)).text(),
});
```

## Tools the model can call

```js
import { alalanetTools } from "@alalanet/ai-sdk";

const { text } = await generateText({
  model: "openai/gpt-5-mini",
  tools: { ...alalanetTools() }, // installCheck, preflightPayment, checkRepoConfig
  prompt: "Is it safe to run npx -y @modelcontextprotocol/server-filesystem?",
  stopWhen: isStepCount(3),
});
```

| tool | asks | input |
|---|---|---|
| `installCheck()` | `POST /v1/install-check` | `target`: a package, an install command, a GitHub URL or an MCP config entry as JSON |
| `preflightPayment()` | `GET` or `POST /v1/preflight` | `url`, optional `paymentRequired` and `maxUsd` |
| `checkRepoConfig()` | `GET` or `POST /v1/repo-config-check` | `repo` (and `ref`) of a public GitHub repository, or `files` of a local checkout |

Each returns alalanet's verdict (`decision`, `reasons`, and the rest the model needs; `attestation_id`
names the signed statement, `full: true` returns the whole answer). An error comes back as a result,
`{ error, hint }`, with `pay_per_call` when the daily limit is used up, so the model can read it.

## Options

| option | default | |
|---|---|---|
| `shellTools` | `DEFAULT_SHELL_TOOLS` | tool names, or `{ name: (input) => line \| lines }` |
| `detectCommandInput` | `true` | any tool with a command line in `command`, `cmd`, `commandLine`, `command_line` or `script` counts as a shell |
| `prefilter` | `true` | `true`: send every line but those that only print (see above); `false`: every line; a function `(line) => boolean`: your own test |
| `requireSilenceMark` | `false` | an empty answer allows only with `Alalanet-Silence: nothing-to-check` (see below) |
| `paymentTools` | none | tool names, or `{ name: (input) => url \| { url, paymentRequired?, maxUsd? } }` |
| `maxUsdPerCall` | none | `max_usd` for preflight, in US dollars |
| `onHold` | `"ask"` | `"deny"`: deny a hold instead of asking |
| `onUnchecked` | `"ask"` | `"deny"`: deny when alalanet could not check; never `"allow"` |
| `fallback` | none | your own `toolApproval` (map or function), merged strictest first |
| `onDecision(d)` | none | every verdict: `{kind, toolName, toolCallId, decision, reason \| reasons, checked}` |
| `token` | `ALALANET_TOKEN` | a plan's token, sent as `Authorization: Bearer` |
| `deviceKey` | `ALALANET_DEVICE_KEY` | a free device key for the hook's own checks a day (below) |
| `timeoutMs` | `20000` | per request to alalanet |
| `api` | `https://alalanet.com` | over plain http only to this machine for a token or key |
| `fetch` | `globalThis.fetch` | |
| `userAgent` | none | put in front of this package's User-Agent |

`checkCommand(line, opts)` and `preflight({ url, paymentRequired, maxUsd }, opts)` are the calls underneath,
for your own policy.

## What is sent to alalanet, and what it keeps

- **A shell command.** Every line but those that only print (above), whole, as typed, in one request
  `POST https://alalanet.com/v1/hooks/claude-code` as
  `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"…"}}`, the same request
  alalanet's other install hooks send, with the User-Agent `alalanet-ai-sdk/<version> (hook)`. The tool's
  other input, its output, your messages and prompts are never sent. A line over 1 MiB is not sent; it asks.
  alalanet reads what the line installs or runs and checks those; in the words of its privacy statement, "We
  never store or log the command line itself."
- **Secrets in a command line.** A token or password typed into a line (`curl -H "Authorization: Bearer sk-…"`)
  goes with it, over HTTPS, to alalanet, which reads the line to answer and does not keep it. Keep secrets in
  environment variables: a line that says `$OPENAI_API_KEY` sends those letters, not the key.
- **A payment.** The URL, and the 402 terms when your extractor returns them, with your `maxUsdPerCall`.
- **The tools.** What the model passes them: a target, a URL and its terms, a repository name or the
  configuration files of a checkout (read to answer, not stored).
- **Headers.** Your plan token or device key if you set one, never over plain http to another machine.
  No cookies; redirects are not followed.

Signed results name the target, the decision and the reasons, never who asked. alalanet keeps no access log;
free limits are counted under hashes made with a key of the UTC day, kept in memory and deleted the next day.
The full statement: [alalanet.com/privacy](https://alalanet.com/privacy).

## Limits

- Free, without an account: 100 checks a day per client address. With a free device key the hook has its own
  1,000 a day: `curl -X POST https://alalanet.com/v1/device-keys` once, put the key in `ALALANET_DEVICE_KEY`.
  Agents behind one address (a CI fleet behind NAT) share these; a used-up limit asks the user (`NOT CHECKED`)
  until 00:00 UTC. Plans: [alalanet.com/pricing](https://alalanet.com/pricing).
- alalanet's hook answers a request that carries `Origin` (a browser's, a worker's, an extension's) with an empty
  200, as it answers a line with nothing to check: a web page must not spend a visitor's checks. So in a browser, a
  browser's worker, an extension or an Electron renderer (`document`, `window`, `chrome.runtime`, a service
  worker's `registration`, `WorkerGlobalScope`, `importScripts`, `process.type === "renderer"`) this package sends
  nothing and every shell command asks: run the agent on a server. The extension, service-worker, worker and
  Electron marks are checked first, so a polyfilled `process` or a user agent string does not hide them. A server
  runtime is checked even with the other globals: Node (also with jsdom, happy-dom or linkedom putting `document` in the global scope), Deno, Bun, and
  Cloudflare Workers (`navigator.userAgent` `Cloudflare-Workers`, whose fetch sends no `Origin`). alalanet will
  mark a real "nothing to check" with the header `Alalanet-Silence: nothing-to-check`. When an answer carries that
  header, it is the only empty answer that allows (another value asks); `requireSilenceMark: true` makes an
  unmarked empty answer ask everywhere, and will be the default once the server sends the mark.
- An answer over 1 MiB is not read: the command asks, a tool gets `answer_too_large`.

Node 22+ (as `ai` 7), Bun, Deno, Cloudflare Workers; `ai` 7.0.178 or later (earlier 7.x versions signed the approval
request of a call the policy denied) and `zod` 3.25 or 4 as peer dependencies, no other dependency. License: MIT.
