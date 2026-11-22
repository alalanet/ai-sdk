// The calls to alalanet that the approval and the tools share: the install hook for a shell command, install_check,
// preflight and check_repo_config. No dependency besides fetch.

export const VERSION = "0.1.0";
const API = "https://alalanet.com";
// The hook route reads at most 1 MiB; a larger command is held here, never sent (the server would ask anyway).
const HOOK_BODY_MAX = 1 << 20;
const REASON_MAX = 2000;

// What the server says when it did not check: Alalanet-Not-Checked on a hook answer.
const NOT_CHECKED_HEADER = "alalanet-not-checked";

export function settings(opts = {}) {
  const api = String(opts.api || API).replace(/\/+$/, "");
  const call = opts.fetch || globalThis.fetch?.bind(globalThis);
  const ua = `${opts.userAgent ? `${opts.userAgent} ` : ""}alalanet-ai-sdk/${VERSION}`;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const token = opts.token ?? env.ALALANET_TOKEN ?? "";
  const deviceKey = opts.deviceKey ?? env.ALALANET_DEVICE_KEY ?? "";
  return { api, call, ua, timeoutMs, token, deviceKey, plainRemote: plainRemote(api) };
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
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

// Text from outside goes to the model and the user: no control or invisible characters, bounded.
export function shown(text, max = REASON_MAX) {
  const t = String(text ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, "")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// In a browser the hook answers every request with silence (a web page must not spend a client's checks), so a
// silent answer there says nothing: a command is never let through on it.
function inBrowser() {
  return typeof window !== "undefined" && typeof window.document !== "undefined";
}

/**
 * Asks alalanet about one shell command line, as alalanet's install hooks do (POST /v1/hooks/claude-code).
 * Returns { decision: "allow" | "deny" | "ask", reason, checked, notChecked? }:
 * - allow: alalanet had nothing to say (no install in the line, or every install allowed);
 * - deny: alalanet blocks an install in it;
 * - ask: alalanet holds one, or could not check (notChecked: "daily-limit", "rate", "unreachable", "too_large",
 *   "browser", "bad_answer"). A failure is never an allow.
 */
export async function checkCommand(command, opts = {}) {
  const s = opts.__settings || settings(opts);
  const line = String(command ?? "");
  const body = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: line } });
  if (new TextEncoder().encode(body).length > HOOK_BODY_MAX) {
    return notChecked("too_large", "the command is too large for alalanet to read");
  }
  if (inBrowser()) return notChecked("browser", "alalanet's install hook does not answer a browser's request; run the agent on a server");
  let res, text;
  try {
    ({ res, text } = await request(s, "/v1/hooks/claude-code", { method: "POST", headers: headers(s, "hook", true), body }));
  } catch (e) {
    return notChecked("unreachable", `alalanet could not be reached (${shown(e?.name === "AbortError" ? "timeout" : e?.message || e, 200)})`);
  }
  if (res.status !== 200) return notChecked("unreachable", `alalanet answered HTTP ${res.status}`);
  if (text.trim() === "") return { decision: "allow", reason: "", checked: true };
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
export async function preflight({ url, paymentRequired, maxUsd, client } = {}, opts = {}) {
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
  const reasons = [...new Set((json.options || []).flatMap((o) => o.reasons || []).concat(json.reasons || []))].map((r) => shown(r, 80));
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
    return { error: "alalanet_unreachable", hint: shown(e?.name === "AbortError" ? "timeout" : e?.message || e, 200) };
  }
}
