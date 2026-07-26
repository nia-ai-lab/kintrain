# KinTrain AIメニュー生成 実装設計

最終更新日: 2026-07-12
対象: 実装正本
ステータス: 実装済み

## 1. 設計方針

- UIは `AiRuntimeEndpoint` に対してメニュー生成専用チャットを行う
- Runtime は通常チャットと同じ AgentCore Runtime をそのまま利用する
- Runtime 側ではメニュー生成用のモード切替を持たない
- メニュー生成かどうかの制御は、UIが組み立てる固定プロンプトと会話文脈で行う
- 登録処理は Runtime -> Gateway(MCP) -> Lambda -> DynamoDB で行う
- 登録は必ず新規作成のみとし、既存データ更新を禁止する

## 2. UI設計

### 2.1 画面構成

- 上部: 初回条件フォーム
- 中央: AIチャット表示領域
- 下部: 追加入力チャット欄

### 2.2 初回条件フォーム

- `方針` セレクト
- `目標` セレクト
- `週間頻度` 数値入力
- `ジム施設入力` テキスト入力
- `個別要求` textarea
- `AIに提案してもらう` ボタン

### 2.3 条件送信後の状態

- フォーム値はチャットセッションの固定コンテキストとして保持する
- 以後の追加チャットでは、毎回その条件コンテキストも Runtime へ送る
- ユーザが条件を修正して再送した場合は、新規セッション化する

- 条件変更時は新規セッションを開始する
- 理由: 会話文脈と生成条件の整合が壊れにくい
- 条件を変更しない場合は、同一セッションでAIと提案内容をブラッシュアップする

## 3. Runtime設計

### 3.1 Runtime入力メタデータ

- Runtime payloadの `inputText` に `policy`、`goal`、`daysPerWeek`、`gymInput`、個別要求、既存メニュー名、既存セット名を固定指示として組み込む
- Runtime payloadの `metadata.userProfile` / `metadata.aiCharacterProfile` は通常AIチャットと共通
- 専用 `menuGenerationContext` フィールドは使用しない

### 3.2 UIが付与する固定指示

- UIは `inputText` に、メニュー生成専用の固定指示を前置して Runtime に送る
- 固定指示には最低限以下を含める
- 今回の会話はトレーニングメニュー作成が目的であること
- 既存メニューや既存メニューセットを変更してはいけないこと
- 登録は必ず新規メニューセット+新規種目であること
- ユーザ明示指示があるまで登録してはいけないこと
- ジム設備情報が不確かな場合は確認すること

### 3.3 システムプロンプトの扱い

- 既存の `SOUL.md` / `PERSONA.md` / `system-prompt.ja.txt` はそのまま使う
- メニュー生成向けの追加指示は Runtime 側のモード分岐ではなく、UIが送る固定プロンプトで与える
- Runtime は通常チャットと同じく `userProfile` / `aiCharacterProfile` を受け取り、既存のシステムプロンプト合成だけを行う

## 4. 構造化データ設計

### 4.1 AIが内部で保持すべき提案モデル

- `setName: string`
- `items: TrainingMenuItemDraft[]`

`TrainingMenuItemDraft`:
- `trainingName`
- `bodyPart`
- `equipment`
- `frequency`
- `defaultWeightKg`
- `defaultRepsMin`
- `defaultRepsMax`
- `defaultSets`
- `description`
- `isAiGenerated = true`

### 4.2 出力方針

- ユーザ向けには自然文で説明
- Runtime内部では上記構造を保持
- 登録指示時にその構造を MCP ツール引数へ変換する

## 5. MCP設計

### 5.1 追加ツール

- `create_training_menu_set_from_ai`

入力:
- `setName: string`
- `items: Array<{
  trainingName: string,
  bodyPart?: string,
  equipment: "マシン" | "フリー" | "自重" | "その他",
  frequency: number,
  defaultWeightKg: number,
  defaultRepsMin: number,
  defaultRepsMax: number,
  defaultSets: number,
  description?: string,
  isAiGenerated: true
}>`
- `makeDefault?: boolean`（現行Lambdaは既定セットが存在するとtrueを拒否し、既定セットがない場合だけ自動で既定化）

identity:
- `userId` / `actorId` は公開schemaへ含めない。
- Gateway REQUEST Interceptorが検証済みCognitoアクセストークンの `sub` を内部専用 `__principalUserId` として注入する。
- MCP Lambdaは `__principalUserId` だけをDynamoDBの `userId` として使用する。
- 詳細は `docs/mcp-security-design.md` を参照する。

出力:
- `trainingMenuSetId`
- `createdCount`

### 5.2 Lambda実装方針

- 既存 `training-menu-api` のロジックを直接 HTTP 経由で再利用しない
- MCP専用 Lambda から DynamoDB へ直接書くか、共有モジュール化した登録ロジックを呼ぶ

現行実装:
- MCP専用Lambdaが検証とDynamoDB書き込みを直接実装している
- HTTP Lambdaとの検証ロジック共通化は未実施

### 5.3 一括登録トランザクション

- 1回のAI登録で以下を作る
- `TrainingMenuSet` 1件
- `TrainingMenuItem` n件
- `TrainingMenuSetItem` n件

制約:
- DynamoDB TransactionWrite は 100 アクション制限がある
- 1メニューセットあたり種目数はMVPでは 20 程度を上限目安とする

設計:
- 1セットあたり最大20種目を許容
- 1トランザクションで十分収まる

### 5.4 既存データ非破壊保証

- `trainingMenuSetId` は新規 UUID
- `trainingMenuItemId` はすべて新規 UUID
- 既存 item / set の `Put` / `Update` は禁止
- リクエスト内および既存メニューとの `normalizedTrainingName` 重複は409で拒否する

## 6. ジム設備情報の扱い

### 6.1 入力がURLの場合

- Runtime の web tool で URL を取得する
- HTML本文から設備情報抽出を行う

### 6.2 入力が名称の場合

- Runtime の web tool で検索または直接取得を試みる
- 取得できない場合はユーザにURL提示を依頼する

### 6.3 現行ツールとの整合

- 既存 Runtime は `WEB_SEARCH_PROVIDER` により `http_request` / `tavily` / `exa` を切替可能
- メニュー生成でも同じ仕組みを使う
- URL直指定の場合は `http_request` だけでも実用上十分なケースが多い

## 7. UI登録フロー

### 7.1 推奨フロー

1. ユーザが条件送信
2. AIが案を提示
3. ユーザがブラッシュアップ
4. ユーザが `この内容で登録して` と明示
5. Runtime が保持中の構造化案を MCP へ送る
6. MCP が新規セット + 新規種目を作成
7. UIへ成功メッセージを返す
8. UIが Core API を再取得してメニュー画面へ反映

### 7.2 UI更新

- 登録成功後、UI は `refreshCoreData()` を呼ぶ
- 新規作成されたセットへの自動切替は行わず、再取得後も現在の選択を維持する

## 8. 既存仕様との整合

- 既存 `AIチャット` 画面とは別画面であるため、通常チャットの会話履歴と混在しない
- `AiChatSession` の概念は再利用できるが、用途別にセッションを分離する
- 通常AIチャットとAIメニュー生成は別セッションにし、Runtime 側のモード切替は行わない
- 既存 `TrainingMenuItem.isAiGenerated` フラグを利用できるため、新規テーブル追加は不要

## 9. 実装上の決定事項

- 既定セットがない場合だけ新規セットを既定にし、既存の既定セットは切り替えない
- 登録後は `refreshCoreData()` で再取得するが、表示対象セットの自動切替はしない
- 既存メニュー名との重複は拒否する
- 条件変更時は新規セッション、同条件の追加指示は同一セッションとする
- 提案は会話文脈に保持し、登録時にモデルがtool inputへ構造化する
