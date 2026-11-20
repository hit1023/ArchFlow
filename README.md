# ARCHPULSE (hit-archflow)

自然言語で構成を説明すると、各部品の**役割が動きで分かるアーキテクチャ図**と**設計書**を作るWebUI。
作成後は同じ入力欄から、図への修正依頼や質問ができる。

- 例: 「CDN、ロードバランサー、Webサーバー2台、DBの順に流れる図」
  - CDN: ヒットした要求はオリジンに行かず入口へ折り返す(HIT率表示)
  - キュー: 粒が溜まり、後段が空くと順に取り出される
  - ワーカー: 処理中リングと待ち行列
- 製品指定がなければ、LLMが広く使われるOSSを選んで図と設計書に反映する(例: Varnish / HAProxy / RabbitMQ / PostgreSQL)。
- 図は表示領域に合わせて自動で縮小/拡大される(スクロール不要。右上の − FIT + で手動調整)。各ノードの中にOSS名(product)もピルで表示する。
- 詳細仕様は [docs/SPEC.md](docs/SPEC.md)。
- 公開版(Cloudflare Workers): https://archpulse.hitoshi-nakayama-1023.workers.dev

## 起動

```bash
cp app.env.example app.env   # CLAUDE_CODE_OAUTH_TOKEN を設定
docker compose up -d --build
open http://localhost:8897
```

`app.env`(git管理外):

| 変数 | 必須 | 既定 | 説明 |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | 必須 | - | `claude setup-token` で発行した長期トークン。`claude -p` の認証に使う |
| `CLAUDE_MODEL` | 任意 | `sonnet` | 使用モデル |
| `CLAUDE_TIMEOUT_MS` | 任意 | `180000` | 図生成1回の上限。仕様書は固定で300秒 |

ポートは `docker-compose.yml` の `8897:8080`。ローカルでNode直起動する場合は `PORT=8897 node server.js`(Node 22、`claude` CLI が必要)。

## 使い方

1. 左の入力欄に構成を書いて送信(Enter。Shift+Enterで改行)。10〜60秒で図が出る。
2. 図が出たら、続けて送信すると**修正依頼**または**質問**として扱われる。
   - 修正: 「Webサーバーを3台に増やして」「入口にWAFを追加して」
   - 質問: 「ボトルネックはどこ?」「なぜRedisを選んだ?」(図は変わらず、返答だけ返る)
3. 「負荷を急増」で10秒間流入が4倍になる。キューが溜まる、ワーカーが詰まる様子が見える。
4. 「仕様書」タブに設計書(Markdown)が自動生成される。「仕様書(.md)を保存」「単体HTMLを保存」で書き出せる。
5. 「元に戻す / やり直し」で版を行き来できる(ブラウザに最大12版を保存)。「新規作成に切替」でゼロから作り直す。

## ファイル構成

```
hit-archflow/
├── core.js            プロンプト・JSON検証・設計書整形(Node版とWorker版で共有)
├── server.js          HTTPサーバー + claude -p 呼び出し
├── worker/            Cloudflare Workers版(wrangler.toml, src/index.js)
├── public/
│   ├── index.html     UI(チャット、タブ、Markdown描画、エクスポート)
│   ├── engine.js      描画・シミュレーションエンジン(canvas)。書き出しHTMLにも埋め込まれる
│   ├── sample.json    初期表示の図(Pod→Alloy→Loki)
│   └── sample.md      同サンプルの設計書
├── docs/SPEC.md       仕様書(図JSONスキーマ、挙動、API、設計判断)
├── Dockerfile / docker-compose.yml
└── app.env            秘密情報(git管理外)
```

## Cloudflare Workers版

`worker/` が同じUI(`public/`)と `core.js` をそのまま使う。静的アセット+`/api/*`をWorkerが処理する。

```bash
cd worker
npx wrangler deploy
# Claudeに切り替えたい場合のみ(未設定ならWorkers AIを使う)
npx wrangler secret put ANTHROPIC_API_KEY
```

| 項目 | 内容 |
|---|---|
| LLM | 既定は Workers AI(Llama 3.3 70B fp8 fast、鍵不要)。`ANTHROPIC_API_KEY` secret があれば Claude(claude-sonnet-5-5)に切替。画面右上のチップに使用中のモデルを表示 |
| アクセス制限 | 認証なし。KVでIPごと/日(チャット20・仕様書10)と全体/日(400・150)の回数制限 |
| 応答 | 空白を8秒ごとに流すkeepalive付きJSON。エラーはHTTP 200の `{error}` で返す |
| 注意 | Workers AIは仕様書がClaudeより短く簡素になる。KV無料枠は書込み1000回/日 |

## 注意

- 認証は付けていない。公開する場合はBasic認証やSSOを前段に置くこと(誰でも `claude` を呼べて、トークン消費につながる)。
- 図の数値(HIT率、処理時間、流量)は**説明用のシミュレーション値**で、実測や設計値ではない。設計書にもその旨が入る。
- 検証時に `pkill -f "node server.js"` を使わないこと(他のNodeアプリを巻き込む)。ポートでPID指定する。
