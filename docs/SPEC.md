# ARCHPULSE(hit-archflow)仕様書

版: 2026-11-21 / 対象: hit-archflow(Node 22 + `claude` CLI headless、および Cloudflare Workers版、canvas)

## 1. 目的とスコープ

自然言語から**動くアーキテクチャ図**を作り、図への修正依頼・質問と、設計書の自動生成までを1つのWebUIで行う。

| 項目 | 内容 |
|---|---|
| 解決する課題 | 静止した構成図では「CDNだから後段に届かない」「キューに溜まって順に処理される」といった**役割の違い**が伝わらない |
| 利用者 | 構成を説明・学習・提案したい人(個人利用想定、認証なし) |
| 非ゴール | 実システムの性能予測、IaC生成、ログ/メトリクスの実データ連携 |

## 2. 全体構成

```
ブラウザ(index.html + engine.js)
   │  POST /api/chat   {message, current?, history?}  → {reply, spec|null}
   │  POST /api/doc    {spec, request}                → {doc(Markdown)}
   ▼
server.js (Node http, 依存パッケージなし)
   │  spawn: claude -p --output-format json --tools "" --no-session-persistence
   ▼
Claude(CLAUDE_CODE_OAUTH_TOKEN で認証)
```

設計判断:

- **LLMは構成をJSONで返し、描画は固定エンジンが行う。** LLMにHTML/JSを直接書かせると、修正のたびに壊れやすく、挙動(HIT折り返し等)も毎回違う。JSON+固定エンジンなら、追加依頼は「JSONの差分」になり、挙動の品質が一定になる。
- **図と設計書は別リクエスト。** 図は短時間で出してすぐ動かし、設計書(長文)は非同期で後から埋める。設計書はJSONではなくMarkdownをそのまま返させるため、エスケープ事故がない。
- **ツールを与えない(`--tools ""`)。** 図の生成にファイル・コマンド実行は不要で、安全側に倒す。
- 依存ゼロ(Node標準モジュールのみ)。Markdown描画もブラウザ側の自前実装。

### 2.1 Cloudflare Workers版

`worker/src/index.js` が `/api/chat` `/api/doc` `/api/health` を処理し、他は静的アセット(`public/`、`run_worker_first=["/api/*"]`)。プロンプト・検証は `core.js` をNode版と共有する。

- LLM切替: `ANTHROPIC_API_KEY` secretあり → Anthropic API(claude-sonnet-5-5)、なし → Workers AI(Llama 3.3 70B fp8 fast)。`/api/health` が `{provider, model}` を返し、UIのチップに表示。
- 回数制限(KV): IPごと/日 チャット20・仕様書10、全体/日 400・150。認証なし。
- Workerの時間制限対策として、応答は空白を8秒ごとに出すストリーミングJSON。失敗は `{error}` をHTTP 200で返し、クライアントは `!r.ok || j.error` で判定。
- 公開URL: https://archpulse.hitoshi-nakayama-1023.workers.dev

## 3. 図JSON(spec)スキーマ

```jsonc
{
  "title": "string",
  "subtitle": "string?",
  "columnLabels": ["string"],            // 列見出し(列番号順)
  "nodes": [Node],                       // 必須
  "groups": [{"label": "string", "nodes": ["id"]}],
  "edges": [{"from": "id", "to": "id", "label": "string?"}],   // 必須、有向
  "sources": [Source]                    // 必須(1つ以上)
}
```

### 3.1 Node

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | 一意。edges/sources/groupsから参照 |
| `label` | string | 表示名(14文字程度) |
| `product` | string? | 製品名。指定がなければLLMがOSSを選定 |
| `kind` | `pod\|file\|agent\|db\|service\|queue\|user\|cloud\|generic` | 既定の色分けと種別表示 |
| `color` | `blue\|teal\|amber\|red\|purple\|gray`? | kindの色を上書き |
| `col`, `row` | number | 格子位置(小数可)。列=左→右 |
| `counter` | string? | 付けると到達数を「N 〈文字列〉」で表示 |
| `role` | string | 役割の一文。図の下の役割カードと設計書に使う |
| `behavior` | Behavior? | 省略時は即時通過(0.3秒) |

出口の線(`edges`の`from`)が無いノードは**終点**で、粒を吸収して到達数を数える。

### 3.2 Behavior(役割)

| type | パラメータ | シミュレーション内の動き |
|---|---|---|
| `cache` | `hitRate`(0〜1, 既定0.8), `capacity`(既定8) | 到達ごとに確率でヒット。ヒットした粒は**進まず、来た経路を逆走して入口に戻る**。ミスだけ先へ進み、`fill`(キャッシュ充填)が増える。実効ヒット率 = `hitRate × min(1, 0.25 + 0.75 × fill/capacity)` で、起動直後は低く温まると上がる |
| `queue` | `capacity`(既定12) | 粒を内部に保持(FIFO)。後段が受け入れ可能なとき、0.16秒間隔で1件ずつ払い出す。満杯で到達した粒は破棄(×表示)。出口が複数ならラウンドロビン |
| `worker` | `concurrency`(既定1), `time`(秒, 既定1.5) | 同時処理数まで処理(進捗リング)。超えた分は待ち行列(inbox)。処理時間は±15%ゆらぐ。`canAccept`は「処理中+待ち < concurrency」でキューが判定に使う |
| `lb` | - | 0.15秒で、出口へラウンドロビンに振り分け |
| `fanout` | - | 全出口に粒を複製して送る |
| `filter` | `dropRate`(既定0.15), `dropLabel` | 通過時に確率で破棄(×) |
| `batch` | `size`(既定5) | `size`件たまってから、0.07秒間隔で一括放出 |
| `label` | `text` | 通過した粒に札(チップ)を付ける |

### 3.3 Source

```jsonc
{"node": "id", "rate": 1.5,             // 毎秒の発生数(0.2〜6)。実際は ±の揺らぎあり
 "variants": [{"label":"200","color":"teal","weight":90}]}   // 粒の種類と重み。色はNodeのcolorと同じ語彙
```

「負荷を急増」ボタンは全sourceのrateを10秒間4倍にする。通常時は後段の処理能力(`concurrency ÷ time`の合計)が`rate`を少し上回るように設計し、急増時に滞留が見えるようにする(プロンプト側の規約)。

## 4. 描画・シミュレーションエンジン(engine.js)

- 入力: canvas と spec。出力: `{size,autoFit,refit,zoomBy,zoomReset,setPaused,isPaused,setSpeed,burst,destroy}`。
- レイアウト: 列幅270、行高150、ノード190×112(論理座標)。**自動フィット**: 倍率 = clamp(min(幅/図幅, 高さ/図高), 0.5, 1.5) × 手動ズーム。ResizeObserverで追従し、スクロール不要を基本とする。UIの − FIT + で手動調整。
- ノード内に製品名(`product`)をピル表示(アクセント枠)。
- 粒の移動: 直線(ノード中心間)を秒速230(論理px)。ノード内では描画せず、ノード内部の可視化(キュー=セル、ワーカー=リング、キャッシュ=スロット+HIT率)で表現。ヒット後の戻り粒は線から9px横にずらして描く(往路と重ならない)。
- 初期状態: 300ステップ(約10秒分)を先に回してから表示し、開いた瞬間から流れている状態にする。
- 色: CSS変数(`--k8s` `--info` `--loki` `--err` `--purple` 等)から取得。ライト/ダーク追従。単体HTML書き出しでは現在の値を埋め込む。
- 上限: 粒は同時320個まで(超えたら発生を止める)。

## 5. サーバーAPI

### `POST /api/chat`
- 入力: `message`(必須, 4000文字まで), `current`(現在のspec。無ければ新規作成), `history`(直近6件の`{role,text}`)
- 出力: `{"reply": string, "spec": spec|null}`
  - `spec`あり = 新規作成または変更(完全な新しい図)。`null` = 質問への回答のみ。
- LLMが変更か質問か判断する。曖昧なときは確認の返答を返し、specはnull。
- 検証失敗(JSON不正、nodes/edges/sources欠落、未定義idの参照)は、エラー内容を添えて**1回だけ自動再試行**。それでも失敗なら500。
- 同時実行は1件。実行中は429。

### `POST /api/doc`
- 入力: `spec`, `request`(当初の要望+追加依頼の履歴)
- 出力: `{"doc": Markdown}`。タイムアウト300秒。`chat`とは別ロックなので並行可。
- 章立て(固定): 概要と目的 / 構成概要 / コンポーネント一覧 / データフロー / 製品選定理由 / 各コンポーネントの設定例 / 容量・性能の前提 / 障害時の挙動とスケール戦略 / 運用・監視 / セキュリティ / 前提・未決事項

### `GET /api/health`
`{"ok":true,"model":"sonnet"}`

静的ファイルは `public/` を `no-cache` で配信。

## 6. 製品(OSS)選定ルール

ユーザーの指定がなければLLMが広く使われるOSSを選び、`product`に書く。プロンプトの既定の目安:

| 役割 | 既定の製品 |
|---|---|
| CDN/エッジキャッシュ | Varnish(または Nginx cache) |
| LB | HAProxy |
| リバースプロキシ/GW | Nginx / Traefik / Kong |
| キュー / ストリーム | RabbitMQ / Apache Kafka |
| キャッシュ | Redis |
| RDB / 検索 | PostgreSQL / OpenSearch |
| ログ収集 / 保管 | Fluent Bit・Grafana Alloy / Grafana Loki |
| メトリクス / 可視化 | Prometheus / Grafana |
| 認証 / オブジェクト | Keycloak / MinIO |

ユーザーが指定した製品(AWSマネージド等も)はそのまま使う。選定理由は返答(`reply`)と設計書の「製品選定理由」に出る。

## 7. UI仕様

- 左: 会話ログ、入力欄(Enter送信、Shift+Enter改行、IME変換中のEnterは送信しない)、「新規作成に切替」。図があるときの入力は修正依頼/質問、切替後は新規作成。
- 右: ツールバー(一時停止、負荷を急増、速度x1/x2/x0.5、元に戻す、やり直し、書き出し2種)、タブ(アニメ図/仕様書)。
- アニメ図タブ: canvas、役割カード(label・product・role)、JSON直接編集(適用すると新しい版になる)。
- 仕様書タブ: Markdown描画(見出し・表・リスト・コード・太字)。「生成/再生成」で作り直し。
- 版管理: 変更のたびに履歴へ追加。元に戻す/やり直しは図と設計書を同時に切り替える。localStorage(`archflow.state3`)に直近12版を保存(図・設計書・要望のみ。会話ログは保存しない)。
- 書き出し: 単体HTML(図のアニメ+役割カード+設計書を1ファイルに。ライブラリ依存なし、Googleフォントのみ外部)、設計書Markdown。

## 8. 非機能・運用

| 項目 | 内容 |
|---|---|
| 応答時間 | 図: 7〜60秒(構成の複雑さによる)、設計書: 1〜2分 |
| コスト | 1リクエストごとに`claude -p`を1回実行(図)、設計書で1回。トークンはサブスクリプション/OAuthトークンに計上 |
| 認証 | なし(Workers版はIP/全体の回数制限のみ)。ローカル版を公開する場合は前段で必須 |
| セキュリティ | LLMにツールを与えない。入力は4000文字制限。表示は全てエスケープ(Markdown描画も`esc`後に整形) |
| 可用性 | `restart: unless-stopped`。状態はブラウザ側のみでサーバーはステートレス(`/data`は`claude`の設定置き場) |
| ポート | 8897(コンテナ内8080)。h-1上のorb-hologramが8897を使っているため、h-1へ移す際は要変更 |

## 9. 既知の制約と今後

- 図の数値は説明用のシミュレーション。実測値の取り込みは未対応。
- 1ノードに付けられるbehaviorは1つ(例: 「ラベル付け+バッチ」は2ノードに分ける)。
- エッジは直線のみ。交差の多い図は配置(col/row)をLLMに修正させる。
- 設計書は図の変更ごとに自動再生成する(約1〜2分)。差分更新は未対応。
- 未実施: h-1/gateでの公開、スマホ幅・ライトテーマの目視検証、Worker上のAnthropic切替と修正依頼パスの検証、独自ドメイン。
