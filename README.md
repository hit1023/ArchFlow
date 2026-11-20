# ARCHPULSE (hit-archflow)

自然言語で構成を説明すると、**各部品の役割が動きで分かるアーキテクチャ図**と**設計書**を作るWebUI。
作成後は同じ入力欄から、図への修正依頼や質問ができる。

- 公開版(Cloudflare Workers): https://archpulse.s-quad.com
- ローカル版(Docker): http://localhost:8897
- GitHub: `git@github.com:hit1023/ArchFlow.git`
- 詳細仕様: [docs/SPEC.md](docs/SPEC.md)

## 何ができるか

| 機能 | 内容 |
|---|---|
| 動く構成図 | 粒(リクエスト/ログ等)が部品間を流れる。部品ごとに**役割に応じた動き**をする |
| 役割の可視化 | CDN=ヒットした粒は後段に進まず折り返す / キュー=溜まって順に払い出し / ワーカー=処理中リングと待ち行列 / LB=振り分け / フィルタ=遮断 / バッチ=まとめ送り など |
| OSS自動選定 | 製品指定がなければLLMが広く使われるOSS(Varnish, HAProxy, RabbitMQ, PostgreSQL等)を選び、図の各ノード内に名前を表示 |
| 追加依頼・質問 | 図ができたあと「Webサーバーを3台に」「ボトルネックはどこ?」と続けて聞ける(変更なら図を更新、質問なら回答のみ) |
| 設計書の自動生成 | 11章構成のMarkdown設計書を図の変更ごとに生成 |
| 縦/横の切替 | 流れを縦向き(既定)/横向きで切替。選択はブラウザに保存 |
| 自動フィット | 表示領域に合わせて自動で縮小/拡大(スクロール不要)。− FIT + で手動調整 |
| 版管理 | 元に戻す/やり直し(ブラウザに最大12版保存) |
| 書き出し | 単体HTML(アニメ+役割+設計書を1ファイル)、設計書.md |
| 負荷を急増 | 10秒間、流入が4倍。キューの滞留やワーカー詰まりが見える |

### 例

- 「CDN、ロードバランサー、Webサーバー2台、DBの順に流れる図」
- 「注文APIからキューに入れて、ワーカー3台で非同期に処理する構成」
- 「K8sのPodのログをAlloyで集めてLokiに送る流れ」

## 使い方

1. 入力欄(図の下。初回は「新規作成に切替」)に構成を書いて送信(Enter。Shift+Enterで改行。IME変換中のEnterは送信されない)。数十秒で図が出る。
2. 図が出たら、続けて送信すると**修正依頼**または**質問**として扱われる。
   - 修正: 「Webサーバーを3台に増やして」「入口にWAFを追加して」
   - 質問: 「ボトルネックはどこ?」「なぜRedisを選んだ?」
   - 「新規作成に切替」で、ゼロから作り直すモードにできる。
3. ツールバー: 一時停止 / 負荷を急増 / 速度(x1,x2,x0.5) / 縦横切替 / 元に戻す / やり直し。
4. 「仕様書」タブに設計書が自動生成される(「生成/再生成」で作り直し)。
5. 「仕様書(.md)」「単体HTML」で書き出し。下部のJSONを直接編集して適用することもできる。

## アーキテクチャ

```
ブラウザ(index.html + engine.js)
   │ POST /api/chat  {message, current?, history?} → {reply, spec|null}
   │ POST /api/doc   {spec, request}               → {doc}
   ▼
 ┌ ローカル版: server.js (Node) ──→ claude -p (OAuthトークン)
 └ 公開版   : worker/src/index.js ──→ Workers AI / Anthropic API
        ※ プロンプト・JSON検証は core.js を両者で共有
```

- LLMは「図のJSON(spec)」を返すだけ。描画と挙動シミュレーションは固定のcanvasエンジンが行う。修正依頼がJSONの差分になり、挙動の品質が一定になる。
- 図と設計書は別リクエスト。図を先に出し、設計書は後から埋める。

## ローカル版(Docker)

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
| `CLAUDE_TIMEOUT_MS` | 任意 | `180000` | 図生成1回の上限。設計書は固定300秒 |

- ポートは `docker-compose.yml` の `8897:8080`。
- Docker無しなら `PORT=8897 node server.js`(Node 22、`claude` CLI が必要)。
- 更新後は `docker compose up -d --build`。`app.env` の変更は `docker compose up -d`(restartでは反映されない)。
- 同時生成は1件。実行中に送ると429(「生成中です」)。

## Cloudflare Workers版

`worker/` が同じUI(`public/`)と `core.js` を使う。静的アセット+`/api/*`をWorkerが処理する。

```bash
cd worker
npx wrangler deploy
# Claudeに切り替えたい場合のみ(未設定ならWorkers AI)
npx wrangler secret put ANTHROPIC_API_KEY
```

| 項目 | 内容 |
|---|---|
| URL | https://archpulse.s-quad.com (Workersのカスタムドメイン。`wrangler.toml` の `routes`)。workers.dev は無効 |
| LLM | 既定は Workers AI(Llama 3.3 70B fp8 fast、鍵不要)。`ANTHROPIC_API_KEY` があれば Claude(claude-sonnet-5-5)。画面右上のチップに使用中のモデルを表示 |
| アクセス制限 | 認証なし。KVでIPごと/日(チャット20・仕様書10)と全体/日(400・150)の回数制限 |
| 応答 | 空白を8秒ごとに流すkeepalive付きJSON。エラーはHTTP 200の `{error}` で返す |
| 注意 | Workers AIは設計書がClaudeより短く簡素。KV無料枠は書込み1000回/日 |

- 制限値や `wrangler.toml` の変数を変えたら再度 `npx wrangler deploy`。
- `*.s-quad.com` は自宅向けのワイルドカードDNSがあるが、カスタムドメインは個別のDNSレコードが優先されるため影響しない(ワイルドカード自体は変更していない)。

## ファイル構成

```
hit-archflow/
├── core.js            プロンプト・JSON検証・設計書整形(Node版/Worker版で共有)
├── server.js          HTTPサーバー + claude -p 呼び出し(ローカル版)
├── worker/            Cloudflare Workers版(wrangler.toml, src/index.js)
├── public/
│   ├── index.html     UI(チャット、タブ、Markdown描画、エクスポート)
│   ├── engine.js      描画・シミュレーションエンジン(canvas)。書き出しHTMLにも埋め込まれる
│   ├── sample.json    初期表示の図(Pod→Alloy→Loki)
│   └── sample.md      同サンプルの設計書
├── docs/SPEC.md       仕様書(JSONスキーマ、挙動、API、設計判断)
├── Dockerfile / docker-compose.yml
└── app.env            秘密情報(git管理外)
```

## トラブルシュート

| 症状 | 原因・対処 |
|---|---|
| 「OAuth session expired」 | ローカル版で `CLAUDE_CODE_OAUTH_TOKEN` が未設定/失効。`claude setup-token` で再発行し `app.env` を更新 |
| 図が出ない/「JSONを解釈できません」 | LLMの出力崩れ。自動で1回再試行する。再度送るか、依頼を短く具体的にする |
| 公開版で「回数制限」 | IPごと/全体の日次制限。翌日に戻る。制限値は `worker/wrangler.toml` |
| 図が小さい | 部品が多いと自動で縮小する。「横向きにする」に切り替えるか、+ で拡大 |
| アニメが目に付く | 点滅は抑えてある(発光は控えめ・ゆっくり減衰)。速度を x0.5 にするとさらに落ち着く |

## 注意

- ローカル版は認証なし。公開する場合はBasic認証やSSOを前段に置くこと(誰でも `claude` を呼べて、トークン消費につながる)。
- 図の数値(HIT率、処理時間、流量)は**説明用のシミュレーション値**で、実測や設計値ではない。設計書にもその旨が入る。
- 検証時に `pkill -f "node server.js"` を使わないこと(他のNodeアプリを巻き込む)。ポートでPID指定する。
