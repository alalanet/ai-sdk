// A local stand-in for alalanet's routes, on 127.0.0.1: the answers follow the shapes the real server gives
// (https://alalanet.com/openapi.json): the hook's JSON or an empty 200, Alalanet-Not-Checked on an ask that did
// not check, silence to a browser's request, the verdicts of preflight, install-check and repo-config-check.
import { createServer } from "node:http";

const SILENCE = { "alalanet-silence": "nothing-to-check" };
const hookJSON = (decision, reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });

export async function fakeAlalanet() {
  const seen = [];
  const state = { legacyOnly: false }; // true: an alalanet older than POST /v1/hooks/command (a 404 there)
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const u = new URL(req.url, "http://x");
    seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body });
    const send = (status, text, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(text);
    };
    if (req.method === "POST" && u.pathname === "/v1/hooks/command" && state.legacyOnly) return send(404, JSON.stringify({ error: "not_found" }));
    if (req.method === "POST" && (u.pathname === "/v1/hooks/claude-code" || u.pathname === "/v1/hooks/command")) {
      if (req.headers.origin || req.headers["sec-fetch-site"]) return send(200, ""); // a browser's request: silence
      let cmd;
      try {
        const j = JSON.parse(body);
        if (j.tool_name !== "Bash") return send(200, "");
        cmd = j.tool_input.command;
      } catch {
        return send(200, hookJSON("ask", "alalanet install_check: NOT CHECKED — alalanet could not read the hook input. Install only if the user confirms."));
      }
      if (cmd.includes("boom")) return send(502, "bad gateway");
      if (cmd.includes("garbage")) return send(200, "<html>");
      if (cmd.includes("slow")) return setTimeout(() => send(200, "", SILENCE), 3000);
      if (cmd.includes("redirect")) return send(302, "", { location: "https://elsewhere.example/" });
      if (cmd.includes("evil-pkg")) return send(200, hookJSON("deny", "alalanet install_check: BLOCK. npm:evil-pkg — osv_malicious. Do not install; tell the user. Details: https://alalanet.com/v1/install-check?target=npm%3Aevil-pkg"));
      if (cmd.includes("brand-new-pkg")) return send(200, hookJSON("ask", "alalanet install_check: HOLD. npm:brand-new-pkg — new_package. Install only if the user confirms."));
      if (cmd.includes("limit-pkg")) return send(200, hookJSON("ask", "alalanet install_check: NOT CHECKED. npm:limit-pkg — alalanet's daily limit for this client is reached. Install only if the user confirms."), { "alalanet-not-checked": "daily-limit" });
      return send(200, "", SILENCE); // nothing to say: the hook's real silence, marked
    }
    if (u.pathname === "/v1/preflight") {
      let url = u.searchParams.get("url");
      if (req.method === "POST") url = JSON.parse(body).url;
      if (!url) return send(400, JSON.stringify({ error: "url_required" }));
      const d = url.includes("bad") ? ["block", ["pay_to_sanctioned"]] : url.includes("new") ? ["hold", ["unknown_service"]] : url.includes("down") ? null : ["allow", []];
      if (!d) return send(503, JSON.stringify({ error: "restarting", hint: "retry in 5 s" }), { "retry-after": "5" });
      return send(200, JSON.stringify({ decision: d[0], options: [{ network: "base", pay_to: "0xAAA", amount: "1000", usd: 0.001, decision: d[0], reasons: d[1] }], expires_at: "2026-11-22T00:05:00Z", meaning: "allow: pay.", attestation: { event: { id: "e1" } } }));
    }
    if (u.pathname === "/v1/install-check") {
      const target = req.method === "POST" ? JSON.parse(body).target : u.searchParams.get("target");
      if (target.includes("quota")) {
        return send(429, JSON.stringify({ error: "quota_exceeded", hint: "Free limit used up until 00:00 UTC.", pay_per_call: { url: "https://alalanet.com/x402/install-check?target=quota", price_usd: "0.01" } }), { "retry-after": "3600" });
      }
      const decision = target.includes("evil") ? "block" : "allow";
      return send(200, JSON.stringify({ target: { ecosystem: "npm", name: target }, decision, reasons: decision === "block" ? ["osv_malicious"] : [], info: [], facts: { big: "x".repeat(10) }, advice: "", checked_at: "2026-11-22T00:00:00Z", meaning: "m", attestation: { event: { id: "a1" }, event_json: "{}" } }));
    }
    if (u.pathname === "/v1/repo-config-check") {
      const p = req.method === "POST" ? JSON.parse(body) : { repo: u.searchParams.get("repo"), ref: u.searchParams.get("ref") };
      const decision = p.files?.[".vscode/tasks.json"] || String(p.repo).includes("trap") ? "block" : "allow";
      return send(200, JSON.stringify({ repo: p.repo || "", ref: p.ref || "", decision, reasons: decision === "block" ? ["folder_open_task"] : [], findings: [], files_read: [], mcp_servers: [], advice: "", checked_at: "2026-11-22T00:00:00Z", meaning: "m" }));
    }
    send(404, JSON.stringify({ error: "not_found" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${server.address().port}`;
  return {
    api,
    seen,
    state,
    hooks: () => seen.filter((s) => s.path === "/v1/hooks/command" || s.path === "/v1/hooks/claude-code"),
    close: () => new Promise((r) => server.close(r)),
  };
}

// An address where nothing listens: a closed port on this machine.
export async function deadApi() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${s.address().port}`;
  await new Promise((r) => s.close(r));
  return api;
}
