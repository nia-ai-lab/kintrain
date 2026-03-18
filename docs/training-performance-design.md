# TrainingPerformance 導入設計

最終更新日: 2026-03-18

## 1. 目的

- `TrainingHistoryTable` に `GymVisit.entries[]` を配列保持している現行設計では、種目別の直近実績・履歴参照時に `userId` 単位で広めに `Query` して Lambda 内で絞り込む必要がある。
- これを解消するため、種目単位の正規化テーブル `TrainingPerformanceTable` を追加し、以下を効率化する。
- 実施画面の `lastPerformanceSnapshot` 取得
- AI/MCP の `get_training_history(trainingMenuItemId, limit)` 取得
- 将来の種目別分析・進捗表示

## 2. 設計方針

- `TrainingHistoryTable` は今後も「1回の来館記録」の正本として残す。
- `TrainingPerformanceTable` は「1種目実施 = 1 item」の読取最適化テーブルとして追加する。
- 1回の `GymVisit` 保存時に、`TrainingHistoryTable` と `TrainingPerformanceTable` の両方へ書き込む。
- 書き込み整合性は 1 回の `TransactWriteItems` で担保する。
- `userId` は全アクセスパターンのパーティションキーに必ず含める。
- `Scan` は使わない。
- 既存データ移行はアプリコード内で考慮しない。
- 既存 `GymVisit` から `TrainingPerformanceTable` へのデータ補完は、すべての実装完了後にアプリ外の別タスクで実施する。
- そのため、本設計では旧データ判定・旧データ互換分岐・読み込み時補正は追加しない。

## 3. 解決したい現行課題

### 3.1 実施画面

現行の `GET /training-session-view?date=YYYY-MM-DD` は以下で直近実績を取得している。

- `TrainingMenuSetTable` からデフォルトメニューセット取得
- `TrainingMenuSetItemTable` からメニューセット項目取得
- `TrainingMenuTable` からメニュー定義取得
- `TrainingHistoryTable.UserStartedAtIndex` を `userId` のみで直近 200 件 `Query`
- 各 `visit.entries[]` を Lambda 内で走査し、`trainingMenuItemId` ごとの直近1件を探す

問題:

- 直近実績が古い場合ほど、無関係な `GymVisit` を多く読む
- `entries[]` をアプリ側で走査するため、件数増加に弱い

### 3.2 MCP / AI

現行の `get_training_history(trainingMenuItemId, limit)` は以下で履歴を取得している。

- `TrainingHistoryTable.UserStartedAtIndex` を `userId` のみで直近 200 件 `Query`
- Lambda 内で `entries[]` を走査し、対象 `trainingMenuItemId` のみ抽出

問題:

- 欲しいのは特定種目の履歴なのに、来館履歴を広く取得している
- 直近 200 visit に対象種目が含まれないと古い履歴が見えない

## 4. 追加ドメイン定義

- `TrainingPerformance`: 1回の種目実施記録
- `TrainingPerformanceSnapshot`: 実施時点のメニュー内容を複製したスナップショット

`TrainingPerformance` は `TrainingHistory` の派生保存であり、正本は `TrainingHistory` とする。

## 5. DynamoDB 物理設計

### 5.1 新設テーブル

- テーブル名: `KinTrain-TrainingPerformanceTable-{branch}`
- 論理ID: `TrainingPerformanceTable`

### 5.2 主キー

- PK: `userId`
- SK: `trainingPerformanceId`

### 5.3 保持属性

- `userId`
- `trainingPerformanceId`
- `visitId`
- `trainingMenuItemId`
- `performedAtUtc`（RFC3339 UTC, 秒精度）
- `visitDateLocal`（`YYYY-MM-DD`）
- `timeZoneId`
- `trainingNameSnapshot`
- `bodyPartSnapshot`
- `equipmentSnapshot`
- `isAiGeneratedSnapshot`
- `frequencySnapshot`
- `weightKg`
- `reps`
- `sets`
- `note`
- `createdAt`
- `updatedAt`

### 5.4 GSI

#### GSI-1 `UserTrainingMenuItemPerformedAtIndex`

- PK: `userId`
- SK: `trainingMenuItemPerformedAtKey`
- 値形式: `{trainingMenuItemId}#{performedAtUtc}`

用途:

- 特定種目の履歴一覧
- 特定種目の直近1件取得

クエリ例:

- `userId = :userId AND begins_with(trainingMenuItemPerformedAtKey, :prefix)`
- `:prefix = "{trainingMenuItemId}#"`
- 降順 + `Limit 1` で直近実績取得

#### GSI-2 `UserPerformedAtIndex`

- PK: `userId`
- SK: `performedAtUtc`

用途:

- 直近の種目実施一覧
- 将来の進捗分析

注記:

- 現時点では UI/API で必須ではないが、将来利用と保守性を考え追加する
- ただし初期実装で未使用でもよい

#### GSI-3 `UserVisitIndex`

- PK: `userId`
- SK: `visitId`

用途:

- `PUT /gym-visits/{visitId}` の更新時に旧 performance 群を取得
- `DELETE /gym-visits/{visitId}` の削除時に performance 群を取得

クエリ例:

- `userId = :userId AND visitId = :visitId`

## 6. 書き込み設計

### 6.1 `POST /gym-visits`

現行:

- `TrainingHistoryTable` に `GymVisit` 1件を `Put`

変更後:

- `TrainingHistoryTable` に `GymVisit` 1件
- `TrainingPerformanceTable` に `entries.length` 件
- 1回の `TransactWriteItems` で書き込む

### 6.2 `PUT /gym-visits/{visitId}`

現行:

- `TrainingHistoryTable` の item を `Put` 上書き

変更後:

- 既存 `visitId` に紐づく `TrainingPerformanceTable` item 群を削除
- 新しい `entries[]` から `TrainingPerformanceTable` item 群を再生成
- `TrainingHistoryTable` の visit 本体も更新
- 全体をトランザクションで更新

注意:

- 1回の visit で扱う entry 数はトランザクション上限 25 件を超えないようアプリ側で制約する
- 目安:
  - `TrainingHistory` 本体 1件
  - `TrainingPerformance` 実施件数 N
  - 削除 + 追加がある更新時は件数が増える
- そのため、`PUT /gym-visits` の1回あたり最大 entry 数を 10 件程度で明示制限するのが安全

### 6.3 `DELETE /gym-visits/{visitId}`

変更後:

- `TrainingHistoryTable` の対象 `visitId` を削除
- `TrainingPerformanceTable` の同一 `visitId` に紐づく item 群を削除

補助アクセスではなく、更新・削除の実装を単純に保つため、`UserVisitIndex` は初期実装から追加する。

## 7. API 変更設計

### 7.1 変更対象 API

- `POST /gym-visits`
- `PUT /gym-visits/{visitId}`
- `DELETE /gym-visits/{visitId}`
- `GET /training-session-view?date=YYYY-MM-DD`
- MCP `get_training_history(trainingMenuItemId, limit)`

### 7.2 API 仕様変更の有無

- 外部 API 契約は基本的に変更しない
- レスポンスの取得元を内部的に `TrainingPerformanceTable` へ切り替える

### 7.3 `GET /training-session-view`

現行:

- `TrainingHistoryTable` から recent visits を取得し、`entries[]` を走査して `lastPerformanceSnapshot` を生成

変更後:

- 表示対象メニュー `trainingMenuItemId[]` を取得
- 各 `trainingMenuItemId` について `TrainingPerformanceTable.UserTrainingMenuItemPerformedAtIndex` を降順 `Limit 1` で取得
- 直近1件を `lastPerformanceSnapshot` にマッピング

実装方式:

- item 数が少ない前提のため、まずはメニュー件数分の `Query` を並列実行でよい
- 将来件数が増えたら、直近性能キャッシュの導入を検討する

### 7.4 MCP `get_training_history`

現行:

- recent visits を広く取得し、Lambda 内で `entries[]` から対象種目のみ抽出

変更後:

- `TrainingPerformanceTable.UserTrainingMenuItemPerformedAtIndex`
- `userId = :userId`
- `begins_with(trainingMenuItemPerformedAtKey, :prefix)`
- `ScanIndexForward: false`
- `Limit: :limit`

これにより、対象種目の履歴を直接取得する

## 8. UI 影響範囲

### 8.1 変更が必要な画面

- `/training-session`
- `/daily/:date`
- `/dashboard`
- `/calendar`
- `/ai-chat`（直接表示変更は不要）

### 8.2 実施画面

変更点:

- 見た目と機能は現状維持
- `lastPerformanceSnapshot` の取得元だけ変更

期待効果:

- 古い実績もより正確に取得できる
- 初期表示の取得コストが安定する

### 8.3 Daily / Dashboard / Calendar

変更点:

- 直接 UI 契約変更は不要
- `GymVisit` 保存時に正規化書き込みが追加されるだけ

### 8.4 入力制約

追加すべき制約:

- 1回の `GymVisit.entries` 最大件数を制限する
- 推奨上限: 10

理由:

- 更新時に `TrainingHistory` + `TrainingPerformance` の削除/追加をまとめてトランザクションに載せるため
- DynamoDB `TransactWriteItems` 上限 25 件に収める必要がある

UI要件:

- 実施画面の確認モーダル/保存前バリデーションで、件数超過時は保存不可メッセージを表示する

## 9. AppState / Frontend データモデル変更

### 9.1 既存型は原則維持

- `GymVisit`
- `ExerciseEntry`
- `lastPerformanceSnapshot`

変更方針:

- フロントの型は大きく変えない
- バックエンドが `lastPerformanceSnapshot` を新テーブル由来で返すだけに留める

### 9.2 UI で新設不要なもの

- `TrainingPerformance` をフロントの主要状態としては持たない
- フロントは引き続き `GymVisit` と `DailyRecord` を中心に扱う

## 10. Lambda 実装変更点

### 10.1 `amplify/backend.ts`

- `TrainingPerformanceTable` を追加
- `GSI` を追加
  - `UserTrainingMenuItemPerformedAtIndex`
  - `UserVisitIndex`
  - 任意で `UserPerformedAtIndex`
- `training-history-api` Lambda に新テーブル環境変数と権限付与
- `mcp-tools-api` Lambda に新テーブル環境変数と権限付与

### 10.2 `training-history-api`

- `POST /gym-visits`
  - visit + performance 複数件を一括保存
- `PUT /gym-visits/{visitId}`
  - 既存 performance 削除 + 再作成 + visit 更新
- `DELETE /gym-visits/{visitId}`
  - visit 削除 + performance 削除
- `GET /training-session-view`
  - `lastPerformanceSnapshot` を `TrainingPerformanceTable` から取得

### 10.3 `mcp-tools-api`

- `get_training_history(trainingMenuItemId, limit)`
  - `TrainingPerformanceTable` 直接 Query に変更

## 11. アクセスパターン一覧

### 11.1 新規追加

- AP-P01 特定種目の直近1件取得
  - `Query UserTrainingMenuItemPerformedAtIndex(userId=sub, begins_with(trainingMenuItemPerformedAtKey, "{trainingMenuItemId}#"))`
  - `ScanIndexForward=false`
  - `Limit=1`

- AP-P02 特定種目の履歴一覧取得
  - `Query UserTrainingMenuItemPerformedAtIndex(userId=sub, begins_with(trainingMenuItemPerformedAtKey, "{trainingMenuItemId}#"))`
  - `ScanIndexForward=false`
  - `Limit=n`

- AP-P03 visitId に紐づく performance 群取得
  - `Query UserVisitIndex(userId=sub, visitId=...)`

### 11.2 維持

- AP-H01 来館履歴一覧
  - `TrainingHistoryTable.UserStartedAtIndex`

- AP-H02 来館詳細
  - `GetItem(userId=sub, visitId=...)`

- AP-H03 日単位の筋トレ内容参照
  - `TrainingHistoryTable.UserStartedAtIndex(userId=sub, startedAtUtc BETWEEN fromUtc AND toUtc)`

## 12. 非対象

- 既存 `TrainingHistoryTable` から `TrainingPerformanceTable` へのデータ移行
- 旧データ互換のためのアプリ内分岐
- `TrainingHistoryTable` の廃止
- 新しい外部 API エンドポイント追加

## 13. 実装タスクリスト

1. `TrainingPerformanceTable` の CDK/Amplify 定義追加
2. `training-history-api` に環境変数・権限追加
3. `mcp-tools-api` に環境変数・権限追加
4. `POST /gym-visits` を visit + performance の一括保存へ変更
5. `PUT /gym-visits/{visitId}` を performance 再構築型へ変更
6. `DELETE /gym-visits/{visitId}` を performance 連動削除へ変更
7. `GET /training-session-view` を `TrainingPerformanceTable` 参照へ変更
8. MCP `get_training_history` を `TrainingPerformanceTable` 参照へ変更
9. 実施画面の entry 数上限制御を追加
10. `docs/spec.md` / `docs/ui-spec.md` / README へ反映

## 14. 受け入れ基準

- `POST /gym-visits` 実行時に `TrainingHistoryTable` と `TrainingPerformanceTable` の両方へ保存されること
- `PUT /gym-visits/{visitId}` 実行時に旧 performance が残留しないこと
- `DELETE /gym-visits/{visitId}` 実行時に紐づく performance が削除されること
- 実施画面で、古い直近実績でも正しく表示されること
- MCP `get_training_history` が対象種目の履歴のみを直接取得できること
- すべての `Get / Query` が `userId` をキー条件に含むこと
- `Scan` を使用しないこと
- 既存データ移行ロジックがアプリコードに含まれないこと
