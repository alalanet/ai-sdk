import type { Tool, ToolSet, ToolApprovalStatus, GenericToolApprovalFunction, ToolApprovalConfiguration } from "ai";

/** Options every call to alalanet takes. */
export interface AlalanetCallOptions {
  /** default https://alalanet.com; a token or a device key goes over plain http only to this machine */
  api?: string;
  /** a plan's token, sent as Authorization: Bearer (default: process.env.ALALANET_TOKEN) */
  token?: string;
  /** a free device key (POST /v1/device-keys) for the install hook's own checks a day (default: process.env.ALALANET_DEVICE_KEY) */
  deviceKey?: string;
  /** per request to alalanet, default 20000 */
  timeoutMs?: number;
  /** an empty answer of the hook allows only with Alalanet-Silence: nothing-to-check (default false until alalanet sends that header) */
  requireSilenceMark?: boolean;
  fetch?: typeof globalThis.fetch;
  /** put in front of this package's User-Agent */
  userAgent?: string;
}

/** What to send to preflight for one payment tool call. */
export interface PaymentToCheck {
  url: string;
  /** the 402's PAYMENT-REQUIRED header value or JSON body; without it alalanet judges the terms it last observed at url */
  paymentRequired?: string | object;
  /** budget for this one call, in US dollars */
  maxUsd?: number;
  /** your x402 client library@version (known flaws come back in client_advisories) */
  client?: string;
}

export interface AlalanetDecision {
  kind: "command" | "payment";
  toolName: string;
  toolCallId: string;
  /** command: allow | deny | ask; payment: allow | hold | block | unchecked */
  decision: string;
  reason?: string;
  reasons?: string[];
  url?: string;
  checked?: boolean;
  notChecked?: string;
}

export interface AlalanetApprovalOptions extends AlalanetCallOptions {
  /** tool names that are shells (a list replaces DEFAULT_SHELL_TOOLS; names compare without case, "_" or "-"), or { name: (input) => command line(s) } (adds to them) */
  shellTools?: string[] | Record<string, (input: any) => string | string[] | undefined | Promise<string | string[] | undefined>>;
  /** any tool whose input has a command line in command, cmd, commandLine, command_line or script counts as a shell (default true) */
  detectCommandInput?: boolean;
  /** which lines go to alalanet: true (default) every line but those that only print (isReadOnly); false every line; or your own test, true to send */
  prefilter?: boolean | ((line: string) => boolean | Promise<boolean>);
  /** tools that pay: names (input.url is read), or { name: (input) => url | PaymentToCheck } */
  paymentTools?: string[] | Record<string, (input: any) => string | PaymentToCheck | undefined | Promise<string | PaymentToCheck | undefined>>;
  /** max_usd sent to preflight for a payment tool call */
  maxUsdPerCall?: number;
  /** "ask" (default): a hold waits for the user; "deny": a hold is denied */
  onHold?: "ask" | "deny";
  /** "ask" (default): when alalanet could not check, the user decides; "deny": denied. Never allowed. */
  onUnchecked?: "ask" | "deny";
  /** your own toolApproval (a per-tool map or a function); the strictest of it, the tool's needsApproval and alalanet's wins */
  fallback?: ToolApprovalConfiguration<any, any>;
  /** every verdict */
  onDecision?: (d: AlalanetDecision) => void;
}

/** The AI SDK's GenericToolApprovalFunction: pass it as toolApproval to ToolLoopAgent, generateText or streamText. */
export type AlalanetApproval = GenericToolApprovalFunction<any, any, any>;

export function alalanetApproval(opts?: AlalanetApprovalOptions): AlalanetApproval;

/** The tool names treated as a shell by default. */
export const DEFAULT_SHELL_TOOLS: string[];

/** The tool names that write into a running process, read like shells. */
export const PROCESS_TOOLS: string[];

/** What a shell argv runs: { script }, { encoded } (pwsh -EncodedCommand), { file }, { none }; undefined for another program. */
export function shellScript(argv: string[]): { script?: string; encoded?: true; file?: true; none?: true } | undefined;

/** The command lines in a shell tool's input, and what could not be read (which makes the approval ask). */
export function readCommands(input: unknown): { lines: string[]; unread: string[] };

/** readCommands(input).lines */
export function commandsOf(input: unknown): string[];

/** true when a command line stays in your process: every command in it only prints (ls, pwd, cat, head, tail, wc, echo, printf). */
export function isReadOnly(line: string): boolean;

/** true when a command line goes to alalanet: !isReadOnly(line). */
export function mustSend(line: string): boolean;

export interface CommandVerdict {
  /** allow: nothing to say; deny: alalanet blocks; ask: alalanet holds, or could not check (checked false) */
  decision: "allow" | "deny" | "ask";
  reason: string;
  checked: boolean;
  /** why it was not checked: daily-limit, rate, unreachable, too_large, browser, bad_answer, silence */
  notChecked?: string;
}

/** One command line to alalanet's install hook (POST /v1/hooks/claude-code). Never throws. */
export function checkCommand(command: string, opts?: AlalanetCallOptions): Promise<CommandVerdict>;

export interface PreflightVerdict {
  decision: "allow" | "hold" | "block" | "unchecked";
  reasons: string[];
  /** alalanet's whole answer */
  verdict?: Record<string, unknown>;
  error?: string;
  hint?: string;
}

/** One payment to alalanet's preflight (POST with the 402 terms, GET with the URL alone). Never throws. */
export function preflight(payment: PaymentToCheck, opts?: AlalanetCallOptions): Promise<PreflightVerdict>;

export interface AlalanetToolOptions extends AlalanetCallOptions {
  /** return alalanet's whole answer, signed bundle included (default: the fields the model needs and attestation_id) */
  full?: boolean;
  /** preflightPayment: max_usd when the model passes none */
  maxUsdPerCall?: number;
}

export function installCheck(opts?: AlalanetToolOptions): Tool<{ target: string }, Record<string, unknown>>;
export function preflightPayment(opts?: AlalanetToolOptions): Tool<{ url: string; paymentRequired?: string; maxUsd?: number }, Record<string, unknown>>;
export function checkRepoConfig(opts?: AlalanetToolOptions): Tool<{ repo?: string; ref?: string; files?: Record<string, string> }, Record<string, unknown>>;
export function alalanetTools(opts?: AlalanetToolOptions): {
  installCheck: ReturnType<typeof installCheck>;
  preflightPayment: ReturnType<typeof preflightPayment>;
  checkRepoConfig: ReturnType<typeof checkRepoConfig>;
};

export const VERSION: string;
export type { ToolApprovalStatus, ToolSet };
