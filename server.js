// ArchFlow: 自然言語 → 動的アーキ図(JSON) → 描画エンジンでアニメ化
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 8080;
const MODEL = process.env.CLAUDE_MODEL || "sonnet";
const TIMEOUT = Number(process.env.CLAUDE_TIMEOUT_MS) || 180000;
const PUB = path.join(__dirname, "public");

const core = require("./core");
const { SYSTEM, DOC_SYSTEM } = core;

function runClaude(prompt, system, timeout) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", "--output-format", "json", "--tools", "", "--model", MODEL,
      "--system-prompt", system || SYSTEM, "--no-session-persistence", "--disable-slash-commands",
    ];
    const child = spawn("claude", args, { cwd: "/tmp", env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("タイムアウトしました")); }, timeout || TIMEOUT);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("claude終了コード " + code + ": " + (err || out).slice(0, 300)));
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(String(j.result || "claudeエラー").slice(0, 300)));
        resolve(String(j.result || ""));
      } catch (e) { reject(new Error("claude出力を解釈できません")); }
    });
    child.stdin.end(prompt);
  });
}

let busy = false, busyDoc = false;
async function chat(message, current, history) {
  const base = core.chatPrompt(message, current, history);
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try { return core.parseChat(await runClaude(i === 0 ? base : core.retryPrompt(base, lastErr)), current); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function makeDoc(spec, request) { return core.cleanDoc(await runClaude(core.docPrompt(spec, request), DOC_SYSTEM, 300000)); }

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css" };
function body(req) { return new Promise((r, j) => { let s = ""; req.on("data", (d) => { s += d; if (s.length > 2e6) req.destroy(); }); req.on("end", () => r(s)); req.on("error", j); }); }
function send(res, code, obj) { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); }

http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/chat") {
      if (busy) return send(res, 429, { error: "生成中です。完了後にもう一度お試しください" });
      const { message, current, history } = JSON.parse((await body(req)) || "{}");
      if (!message || !String(message).trim()) return send(res, 400, { error: "メッセージを入力してください" });
      busy = true;
      try { return send(res, 200, await chat(String(message).slice(0, 4000), current, history)); }
      finally { busy = false; }
    }
    if (req.method === "POST" && req.url === "/api/doc") {
      if (busyDoc) return send(res, 429, { error: "仕様書を生成中です" });
      const { spec, request } = JSON.parse((await body(req)) || "{}");
      if (!spec || !spec.nodes) return send(res, 400, { error: "specがありません" });
      busyDoc = true;
      try { return send(res, 200, { doc: await makeDoc(spec, request) }); }
      finally { busyDoc = false; }
    }
    if (req.method === "GET" && req.url === "/api/health") return send(res, 200, { ok: true, model: MODEL });
    // 静的配信
    let p = req.url.split("?")[0];
    if (p === "/") p = "/index.html";
    const f = path.join(PUB, path.normalize(p));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, () => console.log("archflow on " + PORT));
