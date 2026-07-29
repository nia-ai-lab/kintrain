# KinTrain AIメニュー生成 実装設計

最終更新日: 2026-07-29
対象: 実装正本
ステータス: 実装済み

## 1. 構成

```text
TrainingMenuAiGeneratePage
  -> AgentCore Runtime (SSE)
  -> AgentCore Gateway (MCP + Cognito)
  -> REQUEST Interceptor (JWT再検証・本人ID注入)
  -> mcp-tools-api
  -> TrainingMenu / TrainingMenuSet / TrainingMenuSetItem / DailyTrainingPlan
```

UIは登録APIを直接呼ばない。提案と登録判断は同じAI会話で行い、永続化だけをMCPツールへ委譲する。

## 2. UI設計

`TrainingMenuAiGeneratePage` は次を保持する。

- 条件フォーム: 方針、目標、週間頻度、ジム施設、個別要求、有効開始日、有効終了日
- `sessionId`: 通常AIチャットとは別のRuntimeセッションID
- `conditionKey`: 条件変更を検出する正規化済みキー
- `messages`: ユーザー／AIメッセージ
- Runtime進行状態: thinking、tool calling、完了、失敗

会話状態は `kintrain-ai-menu-generation-v1` キーで `sessionStorage` に保存する。
条件変更時は既存会話との不整合を避けるため、新しいセッションを開始する。

初回送信前に次を検証する。

- ジム施設が空でない
- 週間頻度が1〜7の整数
- 有効開始日が終了日以前
- 有効期間が開始日を含め31日以内
- Runtime接続情報が存在する

## 3. Runtime入力

UIは `inputText` にユーザー入力と次の固定指示を組み込む。

- 既存セット・既存種目を更新しない。
- 登録前に `list_training_menu_items` で重複を確認する。
- 既存種目はIDで再利用し、必要な種目だけ新規作成する。
- ユーザーの明示指示前に書き込みツールを呼ばない。
- 1回の登録で1つの有効期間付き一時セットを作る。
- 日付競合を勝手に置き換えない。
- 登録には `create_temporary_training_menu_set_from_ai` を使う。

`metadata.userProfile` と `metadata.aiCharacterProfile` は通常AIチャットと共通である。
Runtime側にメニュー生成専用モードや専用エンドポイントは設けない。

## 4. データ変換

AIの提案項目は、登録時に次の構造へ変換する。

```text
items[]
  existingTrainingMenuItemId?
  newTrainingMenuItem?
    trainingName
    muscleTargets[{ muscleId, role }]
    movementPattern
    laterality
    loadModel
    equipment
    description?
    weightInputMode?
    fixedWeightKg?
  prescription
    targetWeightKg
    targetRepsMin
    targetRepsMax
    targetSets
    recommendedIntervalDays
    instruction?
```

`existingTrainingMenuItemId` と `newTrainingMenuItem` は排他的とする。処方は種目マスタではなく
`TrainingMenuSetItem` に保存する。新規種目は `isAiGenerated=true`、セット項目は `createdBy=ai` とする。

## 5. MCP Lambda設計

`create_temporary_training_menu_set_from_ai` は以下を検証する。

- `idempotencyKey`、日付、セット名、1〜12件の項目
- 期間が1〜31日
- 回数・セット数・推奨間隔の範囲
- 同一セット内の種目重複
- 既存種目が有効かつ本人所有であること
- 新規種目名が本人の既存マスタと重複しないこと
- 期間内の `DailyTrainingPlan` 競合

正常時は次を一貫して作成する。

- `TrainingMenuItem`: 新規種目分
- `TrainingMenuSet`: 1件（`temporary`, `ai`, `version=1`）
- `TrainingMenuSetItem`: 項目数分
- `DailyTrainingPlan`: 有効期間の日数分

同じキー・同じ要求の再実行は冪等リプレイとして扱う。同じキーを異なる要求へ再利用した場合は拒否する。
競合置換はユーザー確認後の `replaceExistingPlan=true` の場合だけ許可する。

## 6. 本人性境界

1. GatewayがCognitoアクセストークンを認可する。
2. REQUEST Interceptorが署名・issuer・client ID・scope・token useを再検証する。
3. Interceptorが公開引数のidentity競合を拒否する。
4. 検証済み `sub` を `__principalUserId` として内部注入する。
5. MCP Lambdaはこの値だけを全DynamoDBキーに使用する。

詳細は `docs/mcp-security-design.md` を正本とする。

## 7. 登録後

- Runtimeは登録結果をユーザーへ説明する。
- UIはストリーム完了後に `refreshCoreData()` を呼ぶ。
- 登録した一時セットは期間内の実施画面で優先表示される。
- 日程変更、内容更新、キャンセルは
  `reschedule_temporary_training_plan`、`update_temporary_training_menu_set`、
  `cancel_temporary_training_plan` を使う。

## 8. テスト観点

- 既存／新規種目混在、12件上限、31日上限
- 重複名、重複ID、他ユーザーID、存在しないID
- 日付競合と確認なし置換の拒否
- 冪等リプレイとキー再利用拒否
- 途中失敗時に部分データが残らないこと
- 登録後のCore API再取得と実施画面反映
- Interceptorによる別ユーザーidentity拒否
