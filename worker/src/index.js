// ARCHPULSE (Cloudflare Workers 版): /api/* を処理し、画面は静的アセットで配信する。
import core from "../../core.js";

const { SYSTEM, DOC_SYSTEM } = core;

function provider(env) {
  const p = env.LLM_PROVIDER || "auto";
  if (p === "anthropic" || (p === "auto" && env.ANTHROPIC_API_KEY)) return "anthropic";
  return "workers-ai";
}
function modelName(env) { return provider(env) === "anthropic" ? env.ANTHROPIC_MODEL || "claude-sonnet-5-5" : env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; }

async function callLLM(env, system, prompt, maxTokens) {
  if (provider(env) === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY が未設定です");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: modelName(env), max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Anthropic API エラー: " + String((j.error && j.error.message) || r.status).slice(0, 200));
    return (j.content || []).map((c) => c.text || "").join("");
  }
  const out = await env.AI.run(modelName(env), { messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: maxTokens });
  const t = out && (out.response != null ? out.response : out.result && out.result.response);
  if (typeof t === "object") return JSON.stringify(t);
  return String(t || "");
}

// ---- Cloudflare Access(メールの確認コード)ログイン。Accessが発行するJWTを検証してメールアドレスを得る ----
const b64d = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
let jwksCache = { at: 0, keys: null };
async function jwks(team) {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600e3) return jwksCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("certs " + r.status);
  jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return jwksCache.keys;
}
function loginEnabled(env) { return !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD); }
async function accessEmail(request, env) {
  if (!loginEnabled(env)) return null;
  try {
    const ck = request.headers.get("cookie") || "";
    const tok = request.headers.get("cf-access-jwt-assertion") || (ck.match(/(?:^|;\s*)CF_Authorization=([^;]+)/) || [])[1];
    if (!tok) return null;
    const [h, p, sig] = tok.split(".");
    const head = JSON.parse(new TextDecoder().decode(b64d(h))), pay = JSON.parse(new TextDecoder().decode(b64d(p)));
    if (head.alg !== "RS256") return null;
    if (pay.exp && pay.exp * 1000 < Date.now()) return null;
    if (pay.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    const aud = Array.isArray(pay.aud) ? pay.aud : [pay.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    const jwk = (await jwks(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === head.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64d(sig), new TextEncoder().encode(h + "." + p));
    return ok && pay.email ? String(pay.email).toLowerCase() : null;
  } catch (e) { return null; }
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// ---- 回数制限(KV。厳密ではなく目安)。ログイン済みはメール単位でより多く使える ----
async function take(env, ip, kind, email) {
  if (!env.RATE) return;
  const day = new Date().toISOString().slice(0, 10), K = kind.toUpperCase();
  const lim = email ? Number(env["LIMIT_USER_" + K] || 100) : Number(env["LIMIT_" + K] || 20), glim = Number(env["LIMIT_GLOBAL_" + K] || 300);
  const ik = email ? `u:${day}:${kind}:${email}` : `i:${day}:${kind}:${ip}`, gk = `g:${day}:${kind}`;
  const [i, g] = await Promise.all([env.RATE.get(ik), env.RATE.get(gk)]);
  if (Number(i || 0) >= lim) { const e = new Error(`本日のこの操作の上限(${lim}回/${email ? "アカウント" : "IP"})に達しました。明日またお試しください。`); e.status = 429; throw e; }
  if (Number(g || 0) >= glim) { const e = new Error("本日の全体の利用上限に達しました。明日またお試しください。"); e.status = 429; throw e; }
  await Promise.all([env.RATE.put(ik, String(Number(i || 0) + 1), { expirationTtl: 172800 }), env.RATE.put(gk, String(Number(g || 0) + 1), { expirationTtl: 172800 })]);
}

// 長い生成でも接続が切れないよう、空白を送り続けてから最後にJSONを返す(クライアントのJSON.parseは先頭空白を許容)
function streamJson(ctx, fn) {
  const enc = new TextEncoder(), { readable, writable } = new TransformStream(), w = writable.getWriter();
  const job = (async () => {
    const t = setInterval(() => w.write(enc.encode(" ")).catch(() => {}), 8000);
    try { await w.write(enc.encode(JSON.stringify(await fn()))); }
    catch (e) { await w.write(enc.encode(JSON.stringify({ error: String((e && e.message) || e) }))).catch(() => {}); }
    finally { clearInterval(t); await w.close().catch(() => {}); }
  })();
  ctx.waitUntil(job);
  return new Response(readable, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
const jerr = (status, msg) => new Response(JSON.stringify({ error: msg }), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function chat(env, message, current, history) {
  const base = core.chatPrompt(message, current, history);
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try { return core.parseChat(await callLLM(env, SYSTEM, i === 0 ? base : core.retryPrompt(base, lastErr), 6000), current); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true, provider: provider(env), model: modelName(env), login: loginEnabled(env), limits: { chat: Number(env.LIMIT_CHAT), doc: Number(env.LIMIT_DOC) } }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/login") return Response.redirect(url.origin + "/", 302); // Accessで保護するパス。通過後はトップへ
    if (url.pathname === "/api/me") return json({ login: loginEnabled(env), email: await accessEmail(request, env) });
    if (url.pathname === "/api/lib") {
      const email = await accessEmail(request, env);
      if (!email) return json({ error: "ログインが必要です" }, 401);
      if (!env.RATE) return json({ error: "保存先がありません" }, 500);
      const k = "lib:" + email;
      if (request.method === "GET") return json({ lib: JSON.parse((await env.RATE.get(k)) || "[]") });
      if (request.method === "PUT") {
        const raw = await request.text();
        if (raw.length > 2.5e6) return json({ error: "履歴が大きすぎます" }, 413);
        let b; try { b = JSON.parse(raw); } catch (e) { return json({ error: "JSONを読み取れません" }, 400); }
        if (!Array.isArray(b.lib)) return json({ error: "libが配列ではありません" }, 400);
        await env.RATE.put(k, JSON.stringify(b.lib.slice(0, 60)));
        return json({ ok: true });
      }
      return json({ error: "method" }, 405);
    }
    if (request.method === "POST" && (url.pathname === "/api/chat" || url.pathname === "/api/doc")) {
      const email = await accessEmail(request, env);
      let body;
      try { body = await request.json(); } catch (e) { return jerr(400, "JSONを読み取れません"); }
      const isChat = url.pathname === "/api/chat";
      if (isChat) {
        const message = String(body.message || "").trim().slice(0, 4000);
        if (!message) return jerr(400, "メッセージを入力してください");
        if (JSON.stringify(body.current || "").length > 80000) return jerr(400, "図が大きすぎます");
        try { await take(env, ip, "chat", email); } catch (e) { return jerr(e.status || 500, e.message); }
        return streamJson(ctx, async () => chat(env, message, body.current || undefined, body.history));
      }
      if (!body.spec || !Array.isArray(body.spec.nodes)) return jerr(400, "specがありません");
      if (JSON.stringify(body.spec).length > 80000) return jerr(400, "図が大きすぎます");
      try { await take(env, ip, "doc", email); } catch (e) { return jerr(e.status || 500, e.message); }
      return streamJson(ctx, async () => ({ doc: core.cleanDoc(await callLLM(env, DOC_SYSTEM, core.docPrompt(body.spec, String(body.request || "").slice(0, 6000)), 7000)) }));
    }
    return env.ASSETS.fetch(request);
  },
};
