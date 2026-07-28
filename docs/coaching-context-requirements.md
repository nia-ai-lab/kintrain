# チャット横断コーチングコンテキスト 要件定義

更新日: 2026-07-28

## 1. 目的

ChatGPT、Claude、KinTrain内蔵AIの各チャットで、ユーザーの目標・制約・好み・現在の指導方針を共有し、一貫した筋トレ助言を受けられるようにする。

各AIサービス固有の会話履歴やMemoryは正本にせず、KinTrainのDynamoDBに保存したコーチングコンテキストを共通の正本とする。

## 2. 基本方針

- トレーニング重量・回数・セット・身体測定値などの正確な数値は既存テーブルを正本とする。
- コーチングコンテキストには、数値履歴を複製せず、現在の目標・制約・好み・判断方針を保存する。
- MCPを利用するAIは、筋トレ相談の開始時に `get_coaching_context` を呼び出す。
- AIによるコンテキスト更新と短期メモ追加は、ユーザーが保存内容を確認して明示的に承認した場合だけ行う。
- AIの回答全文やチャット全文を保存しない。
- 旧 `save_advice_log` と `AiAdviceLogTable` は利用実績がないため、後方互換性やデータ移行を設けず削除する。

## 3. データ分類

### 3.1 現在のコーチングコンテキスト

ユーザーごとに1件だけ保持し、更新時は新しい現在値で置き換える。

- `goalSummary`: 現在の長期・中期目標
- `constraints`: 怪我、痛み、利用器具、時間などの制約
- `preferences`: 種目、頻度、相談スタイルなどの好み
- `trainingPolicy`: 現在のトレーニング指導方針
- `nextReviewDate`: 次回見直し日
- `version`: 楽観ロック用の版番号
- `updatedAt`
- `updatedBySource`: `chatgpt | claude | kintrain | user | other`
- `changeReason`

データ量を一定に保つため、現在値は追記型にしない。

### 3.2 短期の引き継ぎメモ

一時的な観察、判断、次回確認事項、一時的制約だけを保存する。

- 分類:
  - `observation`
  - `decision`
  - `follow-up`
  - `temporary-constraint`
- `content`: 最大1,000文字
- `validFromDate` / `validToDate`: 任意の有効期間
- `source`
- `createdAt`
- `expiresAt`

保存期間は登録から90日とし、DynamoDB TTLで自動削除する。有効なメモは最大50件、AIへ一度に返すメモは新しい順に最大10件とする。

同一要求の再送による重複を避けるため `idempotencyKey` を必須とし、同じキーの登録は同じメモとして扱う。

### 3.3 変更履歴

現在のコーチングコンテキストを更新するたびに、その新しい版のスナップショットを保存する。

- 最大50版
- 保存期間365日
- DynamoDB TTLと件数トリミングを併用
- 過去版の復元は、現在値を上書きせず新しい版として保存する

## 4. DynamoDB

### 4.1 CoachingContextTable

- テーブル名: `KinTrain-CoachingContextTable-{branch}`
- パーティションキー: `userId`
- ソートキー: `recordKey`
- TTL属性: `expiresAtEpoch`
- PITR: 有効

`recordKey`:

- `CONTEXT`: 現在のコーチングコンテキスト
- `NOTE#{noteId}`: 短期メモ
- `REVISION#{createdAt}#{revisionId}`: 変更履歴

`CONTEXT`にはTTLを設定しない。短期メモと変更履歴だけにTTLを設定する。

## 5. MCP

### 5.1 `get_coaching_context(date?, timeZoneId?)`

- 筋トレ相談の開始時に呼び出す。
- 現在のコーチングコンテキストと、指定日に有効な短期メモを最大10件返す。
- `date`省略時は指定タイムゾーンの現在日を使う。
- 内部キー、`userId`、期限切れメモ、変更履歴はAIへ返さない。

### 5.2 `update_coaching_context(...)`

- 現在の目標・制約・好み・指導方針を完全な新しい版として保存する。
- `expectedVersion` を必須とし、同時更新時は競合を返す。
- `changeReason`、`source`、`userConfirmed=true` を必須とする。
- `userConfirmed` がtrueでなければ保存しない。

### 5.3 `append_coaching_note(...)`

- 恒久情報ではない重要事項だけを保存する。
- `idempotencyKey`、分類、内容、更新元、`userConfirmed=true`を必須とする。
- 有効メモが50件に達した場合は追加を拒否する。
- 回答全文や一般的な助言は保存対象外とする。

## 6. Core API

- `GET /coaching-context`
- `PUT /coaching-context`
- `POST /coaching-notes`
- `DELETE /coaching-notes/{noteId}`

すべてCognito認証済みユーザー自身のデータだけを扱う。

## 7. UI

`/coaching-context` に管理画面を設け、設定画面から移動できるようにする。

- 現在の目標、制約、好み、指導方針、次回見直し日の表示・編集
- 更新理由を必須入力
- 現在の版、更新日時、更新元の表示
- 短期メモの追加・一覧・削除
- メモの有効期間、自動削除日、使用件数の表示
- 変更履歴の表示
- 過去版を新しい版として復元
- iPhone幅では入力欄を1列表示

UI上で保存ボタンを押す操作は、本人による明示的承認として扱う。

## 8. 競合・上限・安全性

- コンテキスト更新は `expectedVersion` による楽観ロックを行う。
- MCPのユーザー境界は既存のGateway REQUEST Interceptorが検証したCognito `sub`を使用する。
- 公開引数に `userId`、`actorId`、`__principalUserId` を含めない。
- 値はツール別の許可フィールドだけを返し、DynamoDB項目をそのまま公開しない。
- 制約・好みは各20件、1項目300文字までとする。
- 現在の目標は1,000文字、指導方針は2,000文字、変更理由は500文字までとする。

## 9. データ移行

既存データの移行は行わない。

`AiAdviceLogTable`は利用実績がなく復元も不要というユーザー判断に基づき削除する。CloudFormationの既存Removal Policyによりテーブルが残存した場合は、アプリ更新成功後に対象環境の旧テーブルを明示的に削除する。

## 10. 受け入れ基準

- ChatGPT、Claude、KinTrain内蔵AIが同じコーチングコンテキストを取得できる。
- AIは筋トレ相談開始時にコーチングコンテキストを参照するようツール説明とRuntimeプロンプトで指示される。
- ユーザー承認なしのMCP更新を拒否する。
- 同じ短期メモ要求を再送しても重複登録されない。
- 短期メモが90日後にTTL削除対象になる。
- 有効メモ50件、AI返却10件、変更履歴50版・365日の上限が適用される。
- 競合するコンテキスト更新が既存版を無条件に上書きしない。
- UIから現在値、短期メモ、変更履歴を管理できる。
- `save_advice_log`、`AiAdviceLogTable`、関連環境変数・権限がコードとMCP公開schemaから削除されている。
