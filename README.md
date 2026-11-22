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
the agent again, or `addToolApprovalResponse` in `useChat`. Set `experimental_toolApprovalSecret` too when the
history comes from a browser: without it a client can forge an approval.

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

- Tools named `bash`, `shell`, `sh`, `terminal`, `exec`, `execute`, `run`, `runCommand`, `run_command`,
  `runShell`, `run_shell`, `executeCommand`, `execute_command`, `shellCommand`, `shell_command`,
  `local_shell`, `runTerminalCommand`, `run_terminal_cmd`, `sandbox` or `codeExecution`
  (`DEFAULT_SHELL_TOOLS`). The command is read from `command` (a string, or argv as an array), `commands`
  (a list, each checked), `cmd`, or the same under `action`, as OpenAI's `shell` and `local_shell` send it.
  Such a tool called without any of these asks the user.
- Any other tool whose input has a string `command`, an MCP server's `execute_command` included
  (`detectCommandInput: false` turns this off).
- Your own: `shellTools: { deploy: (input) => input.script }` (a function may return several lines), or a
  list of names to replace the defaults.

Only a line that names a package manager or installer (`npm`, `pnpm`, `yarn`, `bun`, `npx`, `bunx`,
`pnpx`, `pip`, `pip3`, `pipx`, `uv`, `uvx`, `deno`, `go`, `skills`, `clawhub`, `openclaw`; `claude`,
`codex` or `gemini` followed by `mcp`; `--install-extension`, `--add-mcp`), a download together with a
runner (`curl … | sh`, `irm … | iex`), or that builds a word at run time (`$VAR`, `${…}`, `$(…)`, backticks,
`$'…'`, `eval`) is sent. The test is on the whole line's text, also with quotes or backslashes between the
letters, as a path or with `.cmd`, `.exe`, `.bat` or `.ps1`, so a line that only mentions one of them is
sent too. `ls`, `git status` or `curl -o file` never leave your process. `prefilter: false` sends every
command. `mayInstall(line)` is the test.

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
| `detectCommandInput` | `true` | any tool with a string `input.command` counts as a shell |
| `prefilter` | `true` | send only lines that may install or run something (see above) |
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

- **A shell command.** Only a line the test above sends, whole, as typed (anything typed into it, a token
  in a URL included, goes too), in one request `POST https://alalanet.com/v1/hooks/claude-code` as
  `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"…"}}`, the same request
  alalanet's other install hooks send, with the User-Agent `alalanet-ai-sdk/<version> (hook)`. The tool's
  other input, its output, your messages and prompts are never sent. alalanet reads what the line installs or
  runs, checks those, and never stores or logs the line itself. A line over 1 MiB is not sent; it asks.
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
- In a browser alalanet's hook answers nothing (a web page must not spend a visitor's checks), so this
  package asks for every shell command there: run the agent on a server.

Node 22+ (as `ai` 7), Bun, Deno, edge runtimes; `ai` 7 (`toolApproval` came with 7.0.0) and `zod` 3.25 or 4 as
peer dependencies, no other dependency. With `experimental_toolApprovalSecret`, use `ai` 7.0.178 or later: earlier
versions signed the approval request of a call the policy denied. License: MIT.
