# KinTrain AIメニュー生成 実装設計

最終更新日: 2026-03-06
対象: 設計レビュー用
ステータス: 実装前

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

- `menuGenerationContext`
- `policy`
- `goal`
- `daysPerWeek`
- `gymInput`
- `freeTextRequest`
- `userProfile`
- `aiCharacterProfile`

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
- `memo`
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
  memo?: string,
  isAiGenerated: true
}>`
- `makeDefault?: boolean`
- `userId: string`

出力:
- `trainingMenuSetId`
- `trainingMenuItemIds[]`
- `createdCount`

### 5.2 Lambda実装方針

- 既存 `training-menu-api` のロジックを直接 HTTP 経由で再利用しない
- MCP専用 Lambda から DynamoDB へ直接書くか、共有モジュール化した登録ロジックを呼ぶ

推奨:
- `training-menu-api` に閉じた実装を共通ライブラリへ切り出して、HTTP Lambda と MCP Lambda の両方から利用する

理由:
- ビジネスルール重複を避ける
- 一括登録時の検証を統一できる

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
- 既存メニュー名重複は許容するか別途ルール化する必要がある

推奨:
- AI生成では重複メニュー名を許容しない
- 同一ユーザ内で `normalizedTrainingName` 重複がある場合は、AIにリネーム再提案させる

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
- 新規作成されたセットをアクティブにするかは要件確認が必要

## 8. 既存仕様との整合

- 既存 `AIチャット` 画面とは別画面であるため、通常チャットの会話履歴と混在しない
- `AiChatSession` の概念は再利用できるが、用途別にセッションを分離する
- 通常AIチャットとAIメニュー生成は別セッションにし、Runtime 側のモード切替は行わない
- 既存 `TrainingMenuItem.isAiGenerated` フラグを利用できるため、新規テーブル追加は不要

## 9. 要件上の未確定事項

- 登録成功後に新規メニューセットを `isDefault=true` にするか
- 登録成功後に自動でそのセットを表示対象に切り替えるか
- AI提案メニューが既存メニュー名と重複した場合の扱い
- 条件入力変更時に同一セッション継続か、新規セッション化か
- AIが返す提案の構造化形式を、自由文内埋め込みにするか tool/state として保持するか
