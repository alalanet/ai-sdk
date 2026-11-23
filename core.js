// The calls to alalanet that the approval and the tools share: the install hook for a shell command, install_check,
// preflight and check_repo_config. No dependency besides fetch.

export const VERSION = "0.1.1";
const API = "https://alalanet.com";
// The hook route reads at most 1 MiB; a larger command is held here, never sent (the server would ask anyway).
const HOOK_BODY_MAX = 1 << 20;
const REASON_MAX = 2000;

// What the server says when it did not check: Alalanet-Not-Checked on a hook answer.
const NOT_CHECKED_HEADER = "alalanet-not-checked";
// An answer is read up to 1 MiB; a longer one is not read (and a command waits for the user).
const ANSWER_MAX = 1 << 20;
// The hook's empty 200 means "nothing to say", and also "a browser's request, ignored". alalanet marks the first with
// Alalanet-Silence: nothing-to-check (since 2026-11-23), and only that silence allows: an empty 200 without the mark or
// with another value asks. The default; for a self-hosted alalanet older than the mark, turn it off with
// requireSilenceMark: false or ALALANET_REQUIRE_SILENCE_MARK=0 (the option wins over the variable).
export const REQUIRE_SILENCE_MARK = true;
const OFF = new Set(["0", "false", "no", "off"]);
const SILENCE_HEADER = "alalanet-silence";
// The install hook: its neutral name, and the first one, which an alalanet older than 2026-11-23 alone answers (a 404
// on the neutral name is asked once more there: the same hook, quota and answers).
export const HOOK_PATH = "/v1/hooks/command";
const LEGACY_HOOK_PATH = "/v1/hooks/claude-code";
const SILENCE_OK = "nothing-to-check";

export function settings(opts = {}) {
  const api = String(opts.api || API).replace(/\/+$/, "");
  const call = opts.fetch || globalThis.fetch?.bind(globalThis);
  const ua = `${opts.userAgent ? `${opts.userAgent} ` : ""}alalanet-ai-sdk/${VERSION}`;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const token = opts.token ?? env.ALALANET_TOKEN ?? "";
  const deviceKey = opts.deviceKey ?? env.ALALANET_DEVICE_KEY ?? "";
  const markEnv = String(env.ALALANET_REQUIRE_SILENCE_MARK ?? "").trim().toLowerCase();
  const requireSilenceMark = typeof opts.requireSilenceMark === "boolean" ? opts.requireSilenceMark : markEnv !== "" ? !OFF.has(markEnv) : REQUIRE_SILENCE_MARK;
  return { api, call, ua, timeoutMs, token, deviceKey, requireSilenceMark, plainRemote: plainRemote(api) };
}

// Plain http to another machine: a token or a device key is never sent there in the clear.
function plainRemote(api) {
  try {
    const u = new URL(api);
    if (u.protocol !== "http:") return false;
    const h = u.hostname.replace(/^\[|\]$/g, "");
    return !(h === "localhost" || h === "::1" || /^127\./.test(h));
  } catch {
    return false;
  }
}

function headers(s, mode, json) {
  const h = { "user-agent": `${s.ua} (${mode})` };
  if (json) h["content-type"] = "application/json";
  if (!s.plainRemote) {
    if (s.token) h.authorization = `Bearer ${s.token}`;
    else if (s.deviceKey && mode === "hook") h["x-alalanet-device-key"] = s.deviceKey;
  }
  return h;
}

// One request with a deadline; redirects are not followed, so a token never goes to another address.
async function request(s, path, init) {
  if (!s.call) throw new Error("no fetch in this runtime: pass opts.fetch");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), s.timeoutMs);
  try {
    const res = await s.call(`${s.api}${path}`, { ...init, redirect: "manual", signal: ctl.signal });
    const text = await readCapped(res);
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

class AnswerTooLarge extends Error {}

// The answer's text, at most ANSWER_MAX bytes: past that the read stops and the answer counts as not read.
async function readCapped(res) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    if (t.length > ANSWER_MAX) throw new AnswerTooLarge("alalanet's answer is too large to read");
    return t;
  }
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > ANSWER_MAX) {
      reader.cancel().catch(() => {});
      throw new AnswerTooLarge("alalanet's answer is too large to read");
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) all.set(p, (at += p.byteLength) - p.byteLength);
  return new TextDecoder().decode(all);
}

// Text from outside goes to the model and the user: no control or invisible characters, bounded.
export function shown(text, max = REASON_MAX) {
  const t = String(text ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, "")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// A browser, a browser's worker or an extension: its fetch sends Origin, and alalanet's hook answers such a request
// with silence (a web page must not spend a client's checks), so a silent answer there says nothing. A server
// runtime is never one, even with a global document (jsdom, happy-dom, linkedom in tests or server rendering) or
// WorkerGlobalScope (Cloudflare's workerd): Node, Deno and Bun name themselves, workerd's navigator.userAgent is
// "Cloudflare-Workers". An extension (chrome.runtime.id), a service worker (registration), a dedicated worker
// (importScripts) and an Electron renderer (Node's process, but its fetch sends Origin) are browsers, whatever
// else they claim.
export function browserLike() {
  const g = globalThis;
  // marks no server runtime has, checked first: a polyfilled process or a user agent string cannot hide them
  if (g.process?.type === "renderer" || Boolean(g.chrome?.runtime?.id) || Boolean(g.browser?.runtime?.id)) return true;
  if (typeof g.registration !== "undefined" || typeof g.importScripts === "function") return true;
  if (g.process?.versions?.node || g.Deno?.version || g.Bun?.version) return false;
  if (g.navigator?.userAgent === "Cloudflare-Workers") return false;
  return typeof g.document !== "undefined" || typeof g.window?.document !== "undefined" || typeof g.WorkerGlobalScope !== "undefined";
}

/**
 * Asks alalanet about one shell command line, as alalanet's install hooks do (POST /v1/hooks/command).
 * Returns { decision: "allow" | "deny" | "ask", reason, checked, notChecked? }:
 * - allow: alalanet had nothing to say (no install in the line, or every install allowed);
 * - deny: alalanet blocks an install in it;
 * - ask: alalanet holds one, or could not check (notChecked: "daily-limit", "rate", "unreachable", "too_large",
 *   "browser", "bad_answer"). A failure is never an allow.
 */
export async function checkCommand(command, opts = {}) {
  try {
    return await askHook(command, opts);
  } catch (e) {
    return notChecked("bad_answer", `alalanet's answer could not be read (${shown(e?.message || e, 200)})`);
  }
}

async function askHook(command, opts) {
  const s = opts.__settings || settings(opts);
  const line = String(command ?? "");
  const body = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: line } });
  if (new TextEncoder().encode(body).length > HOOK_BODY_MAX) {
    return notChecked("too_large", "the command is too large for alalanet to read");
  }
  if (browserLike()) return notChecked("browser", "alalanet's install hook does not answer a browser's or an extension's request; run the agent on a server");
  let res, text;
  try {
    ({ res, text } = await request(s, HOOK_PATH, { method: "POST", headers: headers(s, "hook", true), body }));
    // an alalanet without the neutral name: the same hook under its first name
    if (res.status === 404) ({ res, text } = await request(s, LEGACY_HOOK_PATH, { method: "POST", headers: headers(s, "hook", true), body }));
  } catch (e) {
    if (e instanceof AnswerTooLarge) return notChecked("bad_answer", e.message);
    return notChecked("unreachable", `alalanet could not be reached (${shown(e?.name === "AbortError" ? "timeout" : e?.message || e, 200)})`);
  }
  if (res.status !== 200) return notChecked("unreachable", `alalanet answered HTTP ${res.status}`);
  if (text.trim() === "") {
    const mark = res.headers?.get?.(SILENCE_HEADER);
    if (mark) {
      if (mark.trim().toLowerCase() === SILENCE_OK) return { decision: "allow", reason: "", checked: true };
      return notChecked("silence", `alalanet answered with silence marked ${shown(mark, 40)}`);
    }
    if (s.requireSilenceMark) return notChecked("silence", "alalanet's silence carried no mark that it had nothing to check");
    return { decision: "allow", reason: "", checked: true };
  }
  let out;
  try {
    out = JSON.parse(text)?.hookSpecificOutput;
  } catch {}
  const decision = out?.permissionDecision;
  const reason = shown(out?.permissionDecisionReason);
  if (decision === "deny") return { decision: "deny", reason, checked: true };
  if (decision === "ask") {
    const nc = res.headers?.get?.(NOT_CHECKED_HEADER);
    return nc ? { decision: "ask", reason, checked: false, notChecked: shown(nc, 40) } : { decision: "ask", reason, checked: true };
  }
  if (decision === "allow") return { decision: "allow", reason, checked: true };
  return notChecked("bad_answer", "alalanet's answer could not be read");
}

function notChecked(code, why) {
  return { decision: "ask", reason: `alalanet install_check: NOT CHECKED — ${why}. Run only if the user confirms.`, checked: false, notChecked: code };
}

/**
 * Asks alalanet about a payment before the tool that pays runs. With paymentRequired (the 402's PAYMENT-REQUIRED
 * header or JSON body) it judges those terms (POST /v1/preflight); with the URL alone, the terms alalanet last
 * observed there (GET /v1/preflight). Returns { decision: "allow" | "hold" | "block" | "unchecked", reasons,
 * verdict?, error? }; "unchecked" when alalanet could not answer.
 */
export async function preflight(payment, opts = {}) {
  try {
    return await askPreflight(payment ?? {}, opts);
  } catch (e) {
    return { decision: "unchecked", reasons: [], error: "bad_answer", hint: shown(e?.message || e, 200) };
  }
}

async function askPreflight({ url, paymentRequired, maxUsd, client }, opts) {
  const s = opts.__settings || settings(opts);
  let res, text;
  try {
    if (paymentRequired !== undefined && paymentRequired !== null && paymentRequired !== "") {
      const body = { url, payment_required: typeof paymentRequired === "string" ? paymentRequired : JSON.stringify(paymentRequired) };
      if (maxUsd !== undefined) body.max_usd = maxUsd;
      if (client) body.client = client;
      ({ res, text } = await request(s, "/v1/preflight", { method: "POST", headers: headers(s, "preflight", true), body: JSON.stringify(body) }));
    } else {
      const q = new URLSearchParams({ url: String(url ?? "") });
      if (maxUsd !== undefined) q.set("max_usd", String(maxUsd));
      if (client) q.set("client", client);
      ({ res, text } = await request(s, `/v1/preflight?${q}`, { method: "GET", headers: headers(s, "preflight", false) }));
    }
  } catch (e) {
    return { decision: "unchecked", reasons: [], error: "alalanet_unreachable", hint: shown(e?.message || e, 200) };
  }
  const json = parse(text);
  if (res.status !== 200 || !json || !["allow", "hold", "block"].includes(json.decision)) {
    return { decision: "unchecked", reasons: [], error: shown(json?.error || `http_${res.status}`, 80), hint: shown(json?.hint || json?.message || "", 500) };
  }
  // options must be a list of objects, reasons lists of strings: any other shape is an answer not read
  const list = (v) => v === undefined || v === null || (Array.isArray(v) && v.every((r) => typeof r === "string"));
  const options = json.options ?? [];
  if (!Array.isArray(options) || !options.every((o) => o && typeof o === "object" && !Array.isArray(o) && list(o.reasons)) || !list(json.reasons)) {
    return { decision: "unchecked", reasons: [], error: "bad_answer", hint: "alalanet's preflight answer has an unexpected shape" };
  }
  const reasons = [...new Set(options.flatMap((o) => o.reasons || []).concat(json.reasons || []))].map((r) => shown(r, 80));
  return { decision: json.decision, reasons, verdict: json };
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// GET or POST one of the check routes and hand its JSON back as the tool's result; an error is a result too, so the
// model reads it ({ error, hint }), never an exception that ends the loop.
export async function getJSON(path, { method = "GET", query, body } = {}, opts = {}) {
  const s = opts.__settings || settings(opts);
  const q = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== ""))}` : "";
  try {
    const { res, text } = await request(s, path + q, {
      method,
      headers: headers(s, "tool", body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = parse(text);
    if (res.status === 200 && json && typeof json === "object") return json;
    const out = { error: shown(json?.error || `http_${res.status}`, 80), hint: shown(json?.hint || json?.message || "", 1000) };
    if (json?.pay_per_call) out.pay_per_call = json.pay_per_call;
    const ra = res.headers?.get?.("retry-after");
    if (ra) out.retry_after_seconds = Number(ra) || shown(ra, 40);
    return out;
  } catch (e) {
    if (e instanceof AnswerTooLarge) return { error: "answer_too_large", hint: e.message };
    return { error: "alalanet_unreachable", hint: shown(e?.name === "AbortError" ? "timeout" : e?.message || e, 200) };
  }
}
