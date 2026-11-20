// ArchFlow: 自然言語 → 動的アーキ図(JSON) → 描画エンジンでアニメ化
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 8080;
const MODEL = process.env.CLAUDE_MODEL || "sonnet";
const TIMEOUT = Number(process.env.CLAUDE_TIMEOUT_MS) || 180000;
const PUB = path.join(__dirname, "public");
const SPEC_DIR = process.env.SPEC_DIR || "/data/specs";

const SYSTEM = `あなたは「動的アーキテクチャ図」の設計者です。ユーザーの自然言語の説明から、各部品の「役割」が動きで分かる図を設計します。
出力は次のJSONオブジェクト1つのみ。前後の説明文、コードフェンス、コメントは禁止です。
{"reply":"ユーザーへの返答(日本語、2〜4文。何を作った/変えたか、または質問への回答)","spec":<下記のJSON仕様 または null>}
- 新規作成、または図の変更依頼: spec に「完全な新しい図」を入れる。reply には変更点と、選んだ製品とその理由を簡潔に書く。
- 現在の図についての質問・説明依頼・相談(例:「なぜキューが必要?」「ボトルネックは?」): spec は null にして reply だけで答える。
- 変更依頼かどうか曖昧なときは、まず reply で確認し spec は null にする。

# 製品(ミドルウェア)の選定
- ユーザーが製品を指定していなければ、あなたの判断で広く使われているOSSを選び、各ノードの "product" に製品名(必要なら版や構成、例: "Redis 7")を書く。
- 目安: CDN/エッジキャッシュ→Varnish(または Nginx cache)、LB→HAProxy、リバースプロキシ/GW→Nginx / Traefik / Kong、キュー→RabbitMQ、ストリーム→Apache Kafka、キャッシュ→Redis、RDB→PostgreSQL、検索→OpenSearch、ログ収集→Fluent Bit / Grafana Alloy、ログ保管→Grafana Loki、メトリクス→Prometheus、可視化→Grafana、認証→Keycloak、オブジェクトストレージ→MinIO、CI→Jenkins / Gitea Actions、コンテナ基盤→Kubernetes。
- ユーザーが指定した製品(AWS等のマネージドを含む)は、そのまま product に使う。選定理由は reply と仕様書で説明できるようにする。
- アプリケーション自体など製品が無い部品は product を省略してよい。

# JSON仕様(spec)
{
  "title":"図のタイトル","subtitle":"一行の説明(任意)",
  "columnLabels":["① 入口","② ..."],                 // 任意。列番号順
  "nodes":[
    {"id":"英数字ハイフン","label":"表示名(14文字以内)","sub":"補足(任意)",
     "kind":"pod|file|agent|db|service|queue|user|cloud|generic",
     "color":"blue|teal|amber|red|purple|gray",       // 任意
     "col":0,"row":0,                                  // 格子配置(小数可)。左から右へ流れるよう列を増やす
     "counter":"件",                                   // 任意。到達数を表示(終点やユーザーに付ける)
     "product":"Redis 7",                              // 製品名(OSS優先)。省略可
     "role":"この部品の役割を一文(40文字以内)",       // 必須。図の下に説明として表示
     "behavior":{...}}                                 // 役割を動きにする。下表
  ],
  "groups":[{"label":"枠名","nodes":["id"]}],         // 任意
  "edges":[{"from":"id","to":"id","label":"任意"}],   // 有向。粒はこの線を通る
  "sources":[{"node":"id","rate":1.5,"variants":[{"label":"200","color":"teal","weight":90},{"label":"5xx","color":"red","weight":10}]}]
}

# behavior の種類(各ノードに最も適したものを必ず付ける。単なる中継は省略可)
- {"type":"cache","hitRate":0.8,"capacity":8}  CDN/キャッシュ。ヒットした粒は先へ進まず、その場で折り返して入口に戻る(オリジンに届かない)。ミスだけ先へ進み、キャッシュが温まるとヒット率が上がる。
- {"type":"queue","capacity":12}               キュー/バッファ。粒が溜まり、後段が空いたら順に取り出される。溢れると捨てられる。
- {"type":"worker","concurrency":2,"time":1.5} 処理に時間がかかる部品(ワーカー、アプリ、DB書込)。同時処理数と処理時間(秒)を持ち、満杯だと待ちが増える。
- {"type":"lb"}                                ロードバランサー。出ていく線へ順番に振り分ける。
- {"type":"fanout"}                            Pub/Subのトピック、ブロードキャスト。全ての出口に複製して送る。
- {"type":"filter","dropRate":0.15,"dropLabel":"遮断"} WAF、ファイアウォール、バリデーション。一部を遮断する。
- {"type":"batch","size":5}                    N件まとまってから一括送信(ログ転送、バッチ書込)。
- {"type":"label","text":"app=api"}            通過する粒に札(ラベル/タグ)を付ける。
省略時は即時通過。出口の線が無いノードが終点(到達数を数える)。

# ルール
- 現実の仕組みに忠実に。CDNならヒット時はWebに行かず戻る、キューなら溜めて後段が順に取る、のように役割の違いが見えること。
- 通常時は後段の処理能力が少し余る程度に rate / concurrency / time を決める(目安: rate < concurrency÷time の合計)。画面の「負荷を急増」ボタンで4倍になり、キューが溜まる様子が見える。
- 並列の入口が複数ならsourcesを複数。分岐はlbかfanoutのノードを置く。edges は from/to が実在するノードidであること。
- sourcesは1つ以上。col は0から最大6列、row は最大5行。ノードは4〜12個。labelは短く。ユーザーの言語(通常は日本語)で。
- 既存の図(current)が与えられたら、追加指示を反映した「完全な新しいspec」を返す。無関係な部分は変えない。
- 有効なJSONのみ。末尾カンマ禁止。

# 例1: CDN(以下 spec 部分のみ示す。実際は {"reply":..., "spec":{...}} で返す。productの付け方に注意)
{"title":"CDNがオリジンを守る流れ","columnLabels":["① 利用者","② エッジ","③ 振り分け","④ アプリ","⑤ データ"],
"nodes":[
{"id":"user","label":"ユーザー","kind":"user","col":0,"row":1,"counter":"件 受信","role":"ページを要求し、応答を受け取る側"},
{"id":"cdn","label":"CDN","kind":"cloud","col":1,"row":1,"product":"Varnish","behavior":{"type":"cache","hitRate":0.8,"capacity":8},"role":"キャッシュにあれば即応答。ヒットした要求はオリジンに届かない"},
{"id":"lb","label":"ロードバランサー","kind":"service","col":2,"row":1,"product":"HAProxy","behavior":{"type":"lb"},"role":"ミスした要求を2台のWebへ順番に振り分ける"},
{"id":"web1","label":"Web 1","kind":"pod","col":3,"row":0,"behavior":{"type":"worker","concurrency":2,"time":0.9},"role":"アプリを実行して応答を作る"},
{"id":"web2","label":"Web 2","kind":"pod","col":3,"row":2,"behavior":{"type":"worker","concurrency":2,"time":0.9},"role":"アプリを実行して応答を作る"},
{"id":"db","label":"DB","kind":"db","col":4,"row":1,"product":"PostgreSQL","counter":"件 処理","behavior":{"type":"worker","concurrency":3,"time":0.5},"role":"データを読み書きする。CDNが効くほど負荷が減る"}],
"edges":[{"from":"user","to":"cdn"},{"from":"cdn","to":"lb","label":"MISS"},{"from":"lb","to":"web1"},{"from":"lb","to":"web2"},{"from":"web1","to":"db"},{"from":"web2","to":"db"}],
"sources":[{"node":"user","rate":2,"variants":[{"label":"GET","color":"teal","weight":85},{"label":"POST","color":"amber","weight":15}]}]}

# 例2: キュー
{"title":"キューで非同期処理","columnLabels":["① 受付","② 待ち行列","③ 処理","④ 保存"],
"nodes":[
{"id":"api","label":"注文API","kind":"service","col":0,"row":1,"role":"注文を受けたらすぐキューに積んで受付完了にする"},
{"id":"q","label":"注文キュー","kind":"queue","col":1,"row":1,"product":"RabbitMQ","behavior":{"type":"queue","capacity":14},"role":"処理しきれない分を溜めておく。後段が空くと古い順に取り出される"},
{"id":"w1","label":"ワーカー1","kind":"service","col":2,"row":0,"behavior":{"type":"worker","concurrency":1,"time":1.4},"role":"1件ずつ時間をかけて処理する"},
{"id":"w2","label":"ワーカー2","kind":"service","col":2,"row":2,"behavior":{"type":"worker","concurrency":1,"time":1.4},"role":"1件ずつ時間をかけて処理する"},
{"id":"db","label":"DB","kind":"db","col":3,"row":1,"counter":"件 保存","role":"処理結果を保存する"}],
"edges":[{"from":"api","to":"q"},{"from":"q","to":"w1"},{"from":"q","to":"w2"},{"from":"w1","to":"db"},{"from":"w2","to":"db"}],
"sources":[{"node":"api","rate":1.2,"variants":[{"label":"通常","color":"teal","weight":90},{"label":"急ぎ","color":"amber","weight":10}]}]}`;

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

function extractJson(text) {
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("JSONが見つかりません");
  return JSON.parse(t.slice(a, b + 1));
}

function validate(spec) {
  if (!spec || !Array.isArray(spec.nodes) || !spec.nodes.length) throw new Error("nodesがありません");
  const ids = new Set();
  for (const n of spec.nodes) {
    if (!n.id || ids.has(n.id)) throw new Error("ノードidが不正/重複: " + n.id);
    if (typeof n.col !== "number" || typeof n.row !== "number") throw new Error("col/rowが数値ではありません: " + n.id);
    ids.add(n.id);
  }
  spec.edges = (spec.edges || []).filter((e) => e && e.from && e.to);
  spec.edges.forEach((e) => { if (!ids.has(e.from) || !ids.has(e.to)) throw new Error("edgesに未定義ノード"); });
  if (!spec.edges.length) throw new Error("edgesがありません");
  spec.sources = (spec.sources || []).filter((s) => s && ids.has(s.node));
  if (!spec.sources.length) throw new Error("sourcesがありません(粒の発生元ノードを指定してください)");
  (spec.groups || []).forEach((g) => { g.nodes = (g.nodes || []).filter((x) => ids.has(x)); });
  return spec;
}

const DOC_SYSTEM = `あなたはシステムアーキテクトです。与えられた「動的アーキテクチャ図のJSON」から、仕様書レベルの設計書をMarkdownで書きます。出力はMarkdown本文のみ(前置き・コードフェンスで全体を囲むのは禁止)。日本語。
次の章立てを守り、図のノード・エッジ・behaviorのパラメータ・productを根拠に具体的に書く。推測した数値は「想定」と明記する。
# {図のタイトル} 設計書
## 1. 概要と目的
## 2. 構成概要
(全体の流れを3〜6行。Mermaidは使わず文章と箇条書き)
## 3. コンポーネント一覧
(表: 名称 / 製品(OSS) / 役割 / 主要パラメータ(図の設定値: 同時処理数・処理時間・容量・ヒット率など))
## 4. データフロー
(番号付き手順。正常系、キャッシュヒット/ミス、キュー滞留、遮断など図にある分岐ごと)
## 5. 製品選定理由
(製品ごとに、なぜそのOSSか、代替案を1つ)
## 6. 各コンポーネントの設定例
(主要な2〜4コンポーネントについて、実在する設定ファイルの短い抜粋をコードブロックで。docker-compose.yml、nginx.conf、haproxy.cfg、redis.conf 等)
## 7. 容量・性能の前提
(図の rate / concurrency / time から、スループットと余力を計算式付きで)
## 8. 障害時の挙動とスケール戦略
(コンポーネント別に、落ちた時・過負荷時・増強方法を表で)
## 9. 運用・監視
(見るべき指標と閾値案、ログ、アラート)
## 10. セキュリティ
## 11. 前提・未決事項
(図のシミュレーション値は説明用の想定であることを明記)`;

let busy = false, busyDoc = false;
function extractSpecWrapper(text) {
  const o = extractJson(text);
  if (o && o.nodes && !("spec" in o)) return { reply: "図を更新しました。", spec: o };
  return o;
}
async function chat(message, current, history) {
  const hist = (history || []).slice(-6).map((h) => `${h.role === "user" ? "ユーザー" : "あなた"}: ${String(h.text).slice(0, 600)}`).join("\n");
  const base = current
    ? `現在の図(current):\n${JSON.stringify(current)}\n\n${hist ? "直近のやりとり:\n" + hist + "\n\n" : ""}ユーザーの発言:\n${message}`
    : `新規作成です。次の説明から図を作成してください(specは必須):\n${message}`;
  let lastErr;
  for (let i = 0; i < 2; i++) {
    const p = i === 0 ? base : base + `\n\n前回の出力は不正でした(${lastErr.message})。ルールを守った有効なJSONだけを返してください。`;
    try {
      const o = extractSpecWrapper(await runClaude(p));
      const reply = String(o.reply || "").slice(0, 1500);
      if (o.spec) return { reply, spec: validate(o.spec) };
      if (!current) throw new Error("specがありません");
      return { reply: reply || "(回答が空でした)", spec: null };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function makeDoc(spec, request) {
  const p = `ユーザーの当初の要望:\n${String(request || "").slice(0, 1500)}\n\n図のJSON:\n${JSON.stringify(spec)}`;
  const md = await runClaude(p, DOC_SYSTEM, 300000);
  return md.trim().replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "");
}

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
