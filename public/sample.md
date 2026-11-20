# Pod のログが Loki に届くまで 設計書

## 1. 概要と目的

Kubernetes クラスタ上で稼働する複数の Pod(api-pod / web-pod / worker-pod)が標準出力(stdout)に出力するログを、ノード上のログファイルを経由して収集エージェント(Grafana Alloy)が集約し、ログ集約基盤である Grafana Loki に転送・保存する。目的は、Pod ごとに散在するログを一元化し、`app` / `pod` / `namespace` といったラベルを付与した状態で LogQL による検索・監視を可能にすることである。本書は、図(JSON)で示されたノード構成・データフロー・パラメータに基づき、各コンポーネントの役割・設定・容量計画・障害時挙動を定義するサンプル設計書である。

## 2. 構成概要

- 各 Pod(api / web / worker)のコンテナランタイム(containerd)が、アプリケーションの stdout を受け取る。
- kubelet がその stdout をノード上のファイル(`/var/log/pods/.../0.log`)に追記形式で書き出す。これらの Pod・ログファイルは同一の「Kubernetes ノード」グループに属する。
- 収集エージェント Alloy が各ノードのログファイルを継続的に読み取り(tail)、`app` / `pod` / `ns` のラベルを付与して Loki へ転送する。
- Loki はラベルをインデックスキーとして、ログ本文をラベル単位でまとめ(chunk 化)、8 行単位でバッチ書き込みを行う。
- 書き込まれたログは LogQL によってラベル・時刻・本文で検索可能になる。

## 3. コンポーネント一覧

| 名称 | 製品(OSS) | 役割 | 主要パラメータ(図の設定値) |
|---|---|---|---|
| api-pod / web-pod / worker-pod | containerd | アプリケーションが標準出力(stdout)にログを書き出す | ログ生成レート: 各 1.1 行/秒(想定・単位は行/秒)、ログ種別比率 INFO 75% / WARN 15% / ERROR 10% |
| 0.log(ノード上のログファイル) | kubelet | stdout をノード上のファイル `/var/log/pods/*/*/0.log` に追記保存 | Pod ごとに専用ファイル(3 系統)。ローテーション設定は未記載(想定: `containerLogMaxSize`) |
| Alloy | Grafana Alloy | 各ログファイルを tail し、`app` / `pod` / `ns` ラベルを付与して Loki に転送 | behavior: `label`(付与ラベル: app / pod / ns) |
| Loki | Grafana Loki | ラベルごとにログをまとめ(chunk)、バッチ単位で永続化。LogQL で検索可能にする | behavior: `batch`(size: 8)、counter: 「行 保存」 |

## 4. データフロー

1. **正常系**: api-pod / web-pod / worker-pod がそれぞれ stdout にログ行を出力する(平均 1.1 行/秒/Pod)。
2. containerd がコンテナの標準出力を受け取り、kubelet がそれを対応するノード上のファイル `0.log` に追記する。
3. Alloy が各ノードの `0.log` を継続的に tail し、ログ行ごとに `app` / `pod` / `namespace` ラベルを付与する。
4. Alloy はラベル付きログ行を内部バッファに蓄積し、Loki への push リクエストとして送信する。
5. Loki は受信したログ行を 8 行(batch size = 8)単位でまとめ、同一ラベル集合のログを chunk として一時格納後、永続ストレージへ書き込む。
6. 書き込み完了後、Loki の「行 保存」カウンタが加算され、LogQL によりラベル・本文・時刻で検索可能になる。

**分岐・異常系**:
- **ログファイル側の滞留**: Alloy が一時的に処理遅延した場合、kubelet は書き込みを継続するため `0.log` にログが蓄積される(ノードのディスク容量に依存)。
- **バッチ未達の滞留**: Loki への送信行数が batch size(8)に満たない場合、Alloy はタイムアウト(想定: 数秒)まで待機してからバッチを送信する。低頻度な Pod(1.1 行/秒)ではこの待機が発生しやすい。
- **Loki 側の遮断(過負荷・ダウン)**: Loki が応答不可の場合、Alloy は WAL(Write-Ahead Log)またはリトライ・バックオフでログを保持し、復旧後に再送する。保持上限を超えた場合はログが欠落する可能性がある。

## 5. 製品選定理由

| 製品 | 選定理由 | 代替案 |
|---|---|---|
| containerd | Kubernetes 標準の CRI 準拠ランタイムであり、追加設定なしで stdout/stderr をログドライバ経由でファイル化できる | CRI-O(同様に CRI 準拠、RedHat 系ディストリビューションで標準採用) |
| kubelet(ログローテーション) | Kubernetes の標準機能として `/var/log/pods` への書き出し・ローテーションを自動管理し、外部エージェント不要 | Fluentd の DaemonSet によるコンテナログ直接収集(ただし kubelet のローテーション機能自体の代替にはならない) |
| Grafana Alloy | Promtail の後継として Grafana が開発する統合収集エージェントで、OpenTelemetry 互換の pipeline を単一バイナリで構成可能。ラベル付与・バッチ転送を宣言的な river 構文で記述できる | Fluent Bit(軽量・高速だが Loki 向けのラベル設計は別途プラグイン実装が必要) |
| Grafana Loki | ログ本文を全文インデックスせずラベルのみインデックス化することで低コストに大量ログを保存でき、LogQL により Prometheus 同様の運用感で検索可能 | Elasticsearch / OpenSearch(全文検索に強いが、インデックスコストとクラスタ運用負荷が高い) |

## 6. 各コンポーネントの設定例

### kubelet(コンテナログローテーション設定)

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
containerLogMaxSize: "10Mi"
containerLogMaxFiles: 5
```

### Alloy(river 構文: ファイル読み取り〜ラベル付与〜Loki転送)

```river
// 対象ノードのログファイルを検出
local.file_match "pods" {
  path_targets = [
    {"__path__" = "/var/log/pods/*/*/0.log"},
  ]
}

loki.source.file "pod_logs" {
  targets    = local.file_match.pods.targets
  forward_to = [loki.process.add_labels.receiver]
}

// app / pod / ns ラベルを付与
loki.process "add_labels" {
  stage.labels {
    values = {
      app       = "",
      pod       = "",
      namespace = "",
    }
  }
  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint {
    url        = "http://loki:3100/loki/api/v1/push"
    batch_size = 8
  }
}
```

### Loki(loki-config.yaml 抜粋)

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

limits_config:
  retention_period: 744h        # 想定: 31日
  ingestion_rate_mb: 4
  ingestion_burst_size_mb: 6

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v12
      index:
        prefix: index_
        period: 24h

chunk_store_config:
  max_look_back_period: 0s
```

### Alloy DaemonSet マニフェスト(抜粋)

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: alloy
  namespace: logging
spec:
  template:
    spec:
      containers:
        - name: alloy
          image: grafana/alloy:latest
          volumeMounts:
            - name: varlogpods
              mountPath: /var/log/pods
              readOnly: true
      volumes:
        - name: varlogpods
          hostPath:
            path: /var/log/pods
```

## 7. 容量・性能の前提

図のソース設定より、各 Pod のログ生成レートは `rate = 1.1`(想定: 行/秒)。

- **Pod 1 台あたりのスループット**: 1.1 行/秒
- **全体スループット(3 Pod 合計)**: 1.1 行/秒 × 3 = **3.3 行/秒**
- **ログ種別分布**: INFO 75%・WARN 15%・ERROR 10%(全体 3.3 行/秒に対し、INFO ≈ 2.48 行/秒、WARN ≈ 0.5 行/秒、ERROR ≈ 0.33 行/秒)
- **Loki バッチ処理間隔**: batch size = 8 行のため、全体レート 3.3 行/秒で換算すると、1 バッチが満たされるまでの平均時間は

  `8 行 ÷ 3.3 行/秒 ≈ 2.4 秒`

  この間隔ごとに Loki への書き込み(chunk 化)が発生する想定。
- **余力評価**: 現状のログ生成量(3.3 行/秒 ≈ 約 285,000 行/日)は小規模サンプル構成であり、Loki・Alloy ともに単一インスタンスで十分に処理可能な負荷である。Pod 数が仮に 10 倍(30 Pod)に増加した場合でも 33 行/秒程度であり、Alloy の DaemonSet 構成・Loki のシングルバイナリモードの限界(想定: 数千行/秒オーダー)には達しない。

## 8. 障害時の挙動とスケール戦略

| コンポーネント | 落ちた時の挙動 | 過負荷時の挙動 | スケール方法 |
|---|---|---|---|
| Pod(api/web/worker) | コンテナ再起動までログ生成が停止。再起動後は新しい `0.log` が作成される | ログ生成レート自体は Pod 側の制御であり、過負荷は想定しにくい | Deployment の replicas 増加、HPA による自動スケール |
| ログファイル(kubelet管理) | ノード障害時にファイル自体が失われる可能性あり(ローカルディスク) | ディスク容量不足時、kubelet が古いログを自動ローテーション・削除 | `containerLogMaxSize` / `containerLogMaxFiles` の調整、ノードディスク増量 |
| Alloy | DaemonSet の Pod が落ちると当該ノードのログ収集が停止。再起動後は position ファイルから読み取り再開 | 転送先(Loki)が遅延すると内部バッファ・WAL に滞留し、上限超過でログ欠落のリスク | ノード追加時に DaemonSet が自動配置されるためノード単位で自動スケール。バッファサイズ・リトライ設定の調整 |
| Loki | プロセス停止時、Alloy 側はリトライ・バックオフで再送を試行し、復旧後に取り込み再開 | 書き込みレートが ingestion_rate_mb を超えると 429(Too Many Requests)を返却し、Alloy側で再送キューに滞留 | シングルバイナリからマイクロサービスモード(distributor / ingester / querier 分離)へ移行してスケールアウト、オブジェクトストレージ(S3等)への移行で容量拡張 |

## 9. 運用・監視

- **Alloy**
  - 監視指標: ファイル読み取りエラー数、`loki_write` の送信失敗率・キュー長
  - 閾値案: 送信失敗率が 5 分間で 5% を超えたらアラート(想定)
- **Loki**
  - 監視指標: `loki_ingester_chunks_flushed_total`、`loki_request_duration_seconds`(push API)、429 応答率
  - 閾値案: push API の p99 レイテンシが 1 秒を超えたら警告、429 応答率が 1% を超えたら警告(想定)
- **kubelet / ノード**
  - 監視指標: `/var/log/pods` が配置されるディスクの使用率
  - 閾値案: ディスク使用率 80% で警告、90% で緊急対応(想定)
- **ログ出力自体**
  - Loki の「行 保存」カウンタの増加が停止(数分間変化なし)した場合、収集パイプラインの異常を疑いアラート発火

## 10. セキュリティ

- Alloy はクラスタ内の Pod・Namespace 情報を取得するため、専用 ServiceAccount に対し `get`/`list`/`watch` 権限のみを付与する最小権限設計とする。
- Alloy から Loki への通信は TLS 化し、マルチテナント運用時は `X-Scope-OrgID` ヘッダーによるテナント分離を行う。
- ログ本文に機密情報(トークン・個人情報等)が含まれる場合は、Alloy の処理ステージ(`stage.replace` 等)でマスキングを実施する。
- `/var/log/pods` へのホストレベルアクセスは、Alloy の DaemonSet コンテナ以外から不要にアクセスできないよう、ノードの RBAC・ファイルパーミッションで制限する。

## 11. 前提・未決事項

- 本図における `rate: 1.1`、`batch size: 8` 等の数値は、挙動説明用のシミュレーション値であり、実際の本番トラフィック量を示すものではない(いずれも想定値)。
- ログ種別比率(INFO 75% / WARN 15% / ERROR 10%)は説明用のサンプル分布であり、実運用でのエラー率はアプリケーション特性に依存する。
- ログファイルのローテーション設定(`containerLogMaxSize` 等)は図に明記されておらず、本書内の数値は一般的な既定値を想定したものである。
- Loki の保存先(ファイルシステム / オブジェクトストレージ)および retention 期間は図に記載がなく、本書では想定値として記載した。実運用では要件に応じて別途決定する必要がある。
- Alloy・Loki 間の認証方式(Basic 認証 / mTLS 等)は図の対象外であり、未決事項として今後の設計で確定する。