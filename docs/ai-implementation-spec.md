# KinTrain AI実装仕様（AgentCore Runtime + Gateway）

最終更新日: 2026-02-28
対象: MVP

## 1. 目的

- AI連携方式を明確化する。
- 認可を Cognito アクセストークン（JWT）で統一する。
- UI と Runtime 間チャットをストリーミングで実装する。

## 2. 対象アーキテクチャ

### 2.1 データ系API

`UI -> API Gateway -> Lambda -> DynamoDB`

### 2.2 AIチャット/提案

`UI -> AgentCore Runtime (Strands + Bedrock Model) -> AgentCore Gateway (MCP) -> Lambda -> DynamoDB`

### 2.3 デプロイ統合方式

- デプロイ基盤は Amplify Gen2 + CDK とする。
- Runtime/Gateway/MemoryなどのAI関連AWSリソースは Amplify Gen2 の `backend.createStack()` で管理する。
- Amplify Gen2 Fullstack Branch Deployment により、1回のブランチデプロイでフロントエンドとバックエンドを同時反映する。

注記:
- AI用途のAPI Gatewayエンドポイント（例: `/ai/chat`, `/ai/advice`）は作成しない。
- UIは `AiRuntimeEndpoint` に直接 `InvokeAgentRuntime` を実行する。

## 3. 認証・認可方式（必須）

## 3.1 共通原則

- 認証トークンは Cognito のアクセストークン（JWT）を使用する。
- トークンは `Authorization: Bearer <token>` で送信する。
- 以下の全経路でJWTを使う。
- `UI -> API Gateway`
- `UI -> AgentCore Runtime`
- `AgentCore Runtime -> AgentCore Gateway`

## 3.2 UI -> API Gateway

- API Gateway は Cognito JWT Authorizer で保護する。
- Core API 全メソッドに `authorizationScopes` を設定し、アクセストークンの `scope` で認可する。
- 必須スコープは `aws.cognito.signin.user.admin` とする。
- IDトークンは Core API の認可トークンとして使用しない。
- JWT の `sub` をユーザー識別子として扱う。

## 3.3 UI -> AgentCore Runtime

- Runtime は Inbound JWT authorizer を設定する。
- Cognito の discovery URL / allowedClients / allowedScopes / requiredClaims を authorizer に設定する。
- UI は Runtime invoke 時に Cognito JWT を `Authorization` ヘッダで送る。

## 3.4 AgentCore Runtime -> AgentCore Gateway（JWT使い回し）

- Runtime 側で `Authorization` ヘッダを受け取るため、Runtime の `request_header_allowlist` に `Authorization` を設定する。
- Runtime のエントリポイントで `context.request_headers["Authorization"]` を取得する。
- 取得した同一JWTを、GatewayへのMCP接続ヘッダ `Authorization: Bearer ...` にそのまま設定する。
- Gateway 側にも Inbound JWT authorizer を設定し、同じ Cognito 設定で検証する。

## 3.5 Gateway -> Lambda

- Gateway target は Lambda を使用する。
- credential provider は `GATEWAY_IAM_ROLE` を使用する（Gateway実行ロールでLambda呼び出し）。
- Lambda のDynamoDBアクセスは最小権限IAMで制限する。

## 3.6 日時コンテキスト（必須）

- Runtimeは各推論で以下を必ずコンテキストに付与する。
- `timeZoneId`（IANA、既定 `Asia/Tokyo`）
- `nowUtc`（RFC3339 UTC）
- `nowLocal`（RFC3339 with offset）
- DynamoDB上の時刻データはRFC3339 UTC（秒精度）を正本として扱う。
- Runtimeはツール取得した時刻を必ず `timeZoneId` 基準のローカル時刻へ変換してからモデルへ渡す。
- 日付境界計算（今日/昨日/今月）は `timeZoneId` 基準で行う。
- UTCのみで日付判定しない。

## 4. ストリーミング方式（UI <-> Runtime）

### 4.1 AIチャットセッションモデル

- `aiChatSessionId`: UI/アプリ側の会話スレッドID（永続）。
- `runtimeSessionId`: Runtimeの会話継続ID（期限切れで再発行あり）。
- `memorySessionId`: Memoryの`sessionId`（同一会話内で固定）。
- マッピング方針:
- `aiChatSessionId 1 : N runtimeSessionId`
- `aiChatSessionId 1 : 1 memorySessionId`
- `runtimeSessionId` 期限切れ時は、同じ `aiChatSessionId` に新しい `runtimeSessionId` を再関連付けする。

### 4.2 MVP採用方式

- `InvokeAgentRuntime` のストリーミング応答（`text/event-stream`）を採用する。
- UIは `fetch` + `ReadableStream` で逐次描画する。
- 会話継続は `runtimeSessionId` を再利用する。

### 4.3 将来拡張

- 双方向低遅延が必要な場合は `WebSocket`（`/ws`）へ拡張可能。
- OAuth認証付きWebSocketも公式サポートされる。

## 5. Runtime実装方針（Strands）

### 5.1 構成

- Runtime内のアプリは Strands を使用する。
- Runtimeエージェントの役割名（ドメイン上の正本）は `AIコーチ` とする。
- モデルは BedrockModel を使い、モデルIDは環境変数で切替可能にする。
- 初期候補は Claude Opus 4.6 系を利用する（利用可能リージョンで有効化）。

### 5.2 トークン使い回し処理（必須）

- Runtimeエントリポイントで `Authorization` ヘッダを取得する。
- Bearerプレフィックスを除去してJWT claims（`sub` など）を取得する。
- 取得した元のBearerトークンを Gateway の `streamablehttp_client(..., headers={"Authorization": ...})` に渡す。
- これにより `UI -> Runtime` で受けたJWTを `Runtime -> Gateway` に使い回す。

### 5.3 ユーザー境界

- `sub` claim をユーザー識別子の唯一の正とする。
- モデル入力に `userId` を直接受け取らせない。
- Runtimeコード側で `sub` をツール引数へ注入して Gateway/Lambda に渡す。

### 5.4 AIキャラクター適用（必須）

- `AIコーチ`（役割）と `AiCharacterProfile`（キャラクター表現）は分離して扱う。
- Runtimeは各チャットターン開始時に `get_ai_character_profile()` を利用してキャラクター設定を取得する。
- `AI_CHARACTER_PROFILE` が未設定の場合は `assets/characters/nyaruko/character-profile.json` を既定として使用する。
- モデル入力へ以下を注入する。
- `agentRoleName`（固定値: `AIコーチ`）
- `characterId`
- `characterName`
- `tonePreset`
- `avatarImageUrl`
- AIキャラクターアイコンは `default` 画像を固定利用し、感情別画像切り替えは行わない。

## 6. Gateway実装方針（MCP）

### 6.1 公開ツール

- `get_recent_gym_visits(days)`
- `get_training_history(trainingMenuItemId, limit)`
- `get_daily_records(from, to)`
- `get_daily_record(date)`
- `get_goal()`
- `get_ai_character_profile()`
- `save_advice_log(advice)`

注記:
- ツール引数には `userId` を公開しない。
- RuntimeがJWT claimsから `sub` を補完して内部的に付与する。

### 6.2 ツール実体

- 各ツールはLambdaで実装し、DynamoDBを参照/更新する。
- PKは `USER#{sub}` で固定し、他ユーザー参照を不可能にする。

## 7. モデル方針

- Runtimeのモデル指定は `MODEL_ID` 環境変数で管理する。
- Claude Opus 4.6 を使う場合のモデルID例:
- `anthropic.claude-opus-4-6-v1`
- モデル可用性はリージョンに依存するため、デプロイ時にBedrock有効化を確認する。

## 8. システムプロンプト管理方針（非ハードコード）

### 8.1 方針

- システムプロンプト文字列をRuntimeコードに直書きしない。
- プログラムコードとは別のテキストファイルとして管理する。

### 8.2 推奨実装

- プロンプトファイルをリポジトリ内に配置し、Runtime起動時に読み込む。
- 推奨パス:
- `config/prompts/system-prompt.ja.txt`
- `config/prompts/PERSONA.md`
- `config/prompts/SOUL.md`
- ファイルパスは環境変数 `SOUL_FILE_PATH` / `PERSONA_FILE_PATH` / `SYSTEM_PROMPT_FILE_PATH` で上書き可能にする。

### 8.3 プロンプトファイル形式

- UTF-8 テキストファイルとする（`.md` / `.txt`）。
- `SOUL.md` / `PERSONA.md` / `system-prompt.ja.txt` の3ファイルを使用する。
- プロンプトの版管理はGit履歴で実施する。

### 8.4 プロンプト合成ルール（AIエージェント設定）

- `SOUL.md`: 根本指針（価値観、優先順位、判断原則）
- `PERSONA.md`: 口調、振る舞い、説明スタイル
- `system-prompt.ja.txt`: ドメイン固有ルール（筋トレ助言方針、禁止事項）
- Runtimeは以下順序で連結して最終システムプロンプトを生成する。
- 1) `SOUL.md`
- 2) `PERSONA.md`
- 3) `system-prompt.ja.txt`
- 4) 実行時コンテキスト（当日目標/履歴要約/日時コンテキスト）
- 5) `AiCharacterProfile`（`characterId`, `characterName`, `tonePreset`）
- 未配置ファイルがある場合は起動失敗（fail-fast）とする。

### 8.5 Runtimeでの読み込み

- Runtime起動時に以下を読み込む。
- `SOUL_FILE_PATH`（既定: `config/prompts/SOUL.md`）
- `PERSONA_FILE_PATH`（既定: `config/prompts/PERSONA.md`）
- `SYSTEM_PROMPT_FILE_PATH`（既定: `config/prompts/system-prompt.ja.txt`）
- 読み込み失敗時は起動失敗（fail-fast）とし、空のプロンプトで稼働しない。
- 1プロセス稼働中はメモリ保持し、変更反映は再デプロイ/再起動で行う。

### 8.6 監査・再現性

- AI応答ログに `soulFilePath`, `personaFilePath`, `systemPromptFilePath`, `promptGitRevision`（コミットID）を保存する。
- これにより、後から「どのプロンプト内容で生成されたか」を追跡できる。

### 8.7 変更運用

- 変更はプロンプトファイルの更新（コード変更なし）で行う。
- 変更は `dev -> stg -> prod` の順に反映する。
- プロンプト変更時は回帰確認シナリオ（助言品質、安全文言、ツール利用）を実行する。
- 問題時は前コミットのプロンプトファイルへロールバックする。

## 9. AgentCore Memory実装方針（長期記録）

### 9.1 採用方針

- Memoryは「会話由来の長期文脈」を保持する用途で使う。
- トレーニングの正確な数値記録（重量/回数/セット）の正本はDynamoDBとする。
- AI応答時は以下を併用する。
- 正確値: Gateway経由でDynamoDB参照
- 長期文脈: Memory検索結果

### 9.2 Memoryリソース設計

- `memoryId`: 環境ごとに1つ（`kintrain-memory-dev` など）
- `actorId`: Cognito `sub` を使用
- `sessionId`: `memorySessionId` を使用（AiChatSession単位）
- `eventExpiryDuration`: 90日（短期イベント保持期間）

補足:
- `eventExpiryDuration` はMemory作成時に設定する。
- rawイベント保持を短中期に制限し、長期知見は抽出済みレコードで保持する。

### 9.3 Memory strategy（KinTrain推奨）

- 初期採用（MVP）
- `UserPreferenceMemoryStrategy`: 目標、好み、制約（例: 苦手部位、相談スタイル）
- `SummaryMemoryStrategy`: 会話の要約を継続保持
- `SemanticMemoryStrategy`: 会話中の重要事実を意味検索可能な形で保持

- 初期非採用（将来）
- `EpisodicMemoryStrategy`: 特定イベントの詳細再現が必要になった時点で追加
- `Custom strategy`: まずはBuilt-inで運用し、要件確定後に導入

### 9.4 イベント投入

- 各チャットターンで `CreateEvent` を実行し、会話をMemoryへ送る。
- `actorId = sub`、`sessionId = memorySessionId` を必須で付与する。
- `payload` はユーザー発話/AI応答を記録する。
- `eventTimestamp` はRFC3339 UTCでサーバー時刻を使用する。
- `eventMetadata` に機微情報を入れない。

### 9.5 検索・利用

- 応答生成前に `RetrieveMemoryRecords` で関連記憶を取得する。
- 検索軸:
- `actorId = sub`
- `namespace`（用途別）
- `searchCriteria.searchQuery = ユーザー最新発話`
- 取得結果をStrandsエージェントに付与して応答品質を向上する。

### 9.6 namespace設計（提案）

- 初期は各strategyのデフォルトnamespaceを使用する。
- 理由:
- Built-in strategyの推奨設定と整合し、運用リスクを下げるため。
- カスタムnamespaceは要件確定後に導入する。

### 9.7 ライフサイクル運用

- 退会時:
- DynamoDBデータ削除に加えてMemoryイベント/レコードも削除対象にする。
- ingestion失敗時:
- `ListMemoryExtractionJobs` で失敗を検知し、`StartMemoryExtractionJobs` で再実行する。
- 監査:
- 失敗件数、抽出遅延、検索ヒット率をメトリクス化する。

### 9.8 このアプリでの最適利用（提案）

- トレーニング実績の事実管理はDynamoDBに一本化し、Memoryは「会話で得た長期文脈」に限定するのが最適。
- 理由（推論）:
- 数値の厳密性が必要なデータをMemoryのみで管理すると、抽象化や遅延抽出の影響を受ける。
- Memoryを補助記憶として使うことで、応答の文脈維持と正確な数値参照を両立できる。

## 10. 実装手順（MVP）

1. Cognito User Pool / App Client を作成し、SPA用アクセストークン取得を有効化。
2. API Gateway に Cognito JWT Authorizer を設定。
3. AgentCore Runtime を作成し、Inbound JWT authorizer を設定。
4. Runtimeに `request_header_allowlist = ["Authorization"]` を設定してデプロイ。
5. AgentCore Gateway を作成し、Inbound JWT authorizer を設定（Runtimeと同じCognito設定）。
6. Gateway target として Lambda を追加（credentialProviderType=`GATEWAY_IAM_ROLE`）。
7. Runtimeコードで JWT 受領 -> claims抽出 -> Gateway呼び出しヘッダへ使い回しを実装。
8. UIから Runtime invoke を `Authorization: Bearer <CognitoAccessToken>` 付きで呼ぶ。
9. UIは `text/event-stream` を逐次表示するチャットUIを実装。
10. `config/prompts/SOUL.md` / `config/prompts/PERSONA.md` / `config/prompts/system-prompt.ja.txt` を作成し、Runtime起動時に読み込む。
11. Runtimeで `timeZoneId` / `nowUtc` / `nowLocal` を毎回生成し、モデル入力へ注入する。
12. Runtimeでツール取得時刻（GymVisit/ExerciseEntry/BodyMetric）を `timeZoneId` 基準のローカル時刻へ変換してから推論に渡す。
13. `assets/characters/nyaruko/character-profile.json` を配置し、`AI_CHARACTER_PROFILE` 未設定ユーザーの既定値として参照する。

## 11. エラー処理要件

- Runtime/GatewayでJWT欠落時は401を返す。
- JWT期限切れ時はUIで再ログインまたはトークン更新導線へ遷移する。
- Gateway呼び出し失敗時はRuntime側で安全な汎用メッセージを返す。
- Lambda異常時はトレースIDをログ出力し、UIには内部詳細を返さない。
- Memory検索失敗時はフォールバックしてDynamoDBのみで応答生成する。
- プロンプトファイル読み込み失敗時はRuntimeを起動しない（fail-fast）。

## 12. 受け入れ基準

- `UI -> Runtime` 呼び出し時、JWTなしでは401になること。
- Runtimeコードで受け取ったJWTを使い、`Runtime -> Gateway` 呼び出しが成功すること。
- Gatewayも同一Cognito JWTで認証できること。
- RuntimeからGatewayへの呼び出し時に `Authorization` ヘッダが設定されること（ログで確認）。
- チャット応答がストリーミング表示されること。
- DynamoDB参照が `sub` 単位で分離されること。
- `CreateEvent` が `actorId/sub` と `memorySessionId` で登録されること。
- `RetrieveMemoryRecords` の結果が応答文脈に反映されること。
- コード変更なしで、プロンプトファイル更新のみで調整できること。
- 応答ログに `soulFilePath`, `personaFilePath`, `systemPromptFilePath`, `promptGitRevision` が保存されること。
- AIの「今日/昨日」判断が `timeZoneId` 基準で一貫すること。
- DynamoDB由来のRFC3339 UTC時刻が、推論前に `timeZoneId` ローカル時刻へ変換されていること。
- `AiCharacterProfile` 変更がチャット口調/表示に反映されること。
- `AI_CHARACTER_PROFILE` 未設定時に `nyaruko` 既定設定へフォールバックできること。

## 13. 公式ドキュメント根拠（確認日: 2026-02-28）

- Inbound JWT authorizer（Runtime/Gateway共通）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/inbound-jwt-authorizer.html
- Runtime OAuth（Bearer token invoke、Authorization allowlist、ヘッダ受領）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html
- Runtime custom headers（Authorization を agent code に渡せる）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html
- Runtime invoke（ストリーミング、OAuth時はHTTPSで呼ぶ）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html
- Runtime invokeガイド（`text/event-stream` と session 管理）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html
- Runtime WebSocket streaming（OAuth対応含む）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html
- Gateway tool call（Authorization header必須）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-call.html
- GatewayをAgent/Strandsに接続（Authorization headerを付与したMCP接続例）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-agent-integration.html
- Gateway targetでLambda + `GATEWAY_IAM_ROLE`  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-api-target-config.html
- Header propagation制約（Authorization allowlist不可/Interceptorで上書き可）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-headers.html
- AgentCore Memory 概要  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html
- AgentCore Memory の仕組み  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-how-it-works.html
- Memory の概念とセッション整理  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-types.html
- Memory の開始手順  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-get-started.html
- RuntimeでMemoryを使う（Strands統合）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/strands-sdk-memory.html
- Build custom Memory strategy  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-self-managed-strategies.html
- Redrive failed ingestions  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-redrive.html
- Specify long-term memory organization  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/specify-long-term-memory-organization.html
- Enable built-in memory strategies  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-enabling.html
- Delete long-term memory records  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-delete-memory-records.html
- CreateMemory API（eventExpiryDuration等）  
  https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateMemory.html
- CreateEvent API（actorId / sessionId / payload）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_CreateEvent.html
- RetrieveMemoryRecords API  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_RetrieveMemoryRecords.html
- ListSessions API  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_ListSessions.html
- ListEvents API  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_ListEvents.html
- ListMemoryExtractionJobs API  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_ListMemoryExtractionJobs.html
- StartMemoryExtractionJobs API  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StartMemoryExtractionJobs.html
- Claude Opus 4.6 のBedrock提供開始（2026-02-05）  
  https://aws.amazon.com/about-aws/whats-new/2026/2/claude-opus-4.6-available-amazon-bedrock/
- Claude Opus 4.6 モデルID（Adaptive thinking）  
  https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html

## 14. 補足（公式情報からの推論を含む項目）

- 「UIで受けたJWTをRuntimeからGatewayへ使い回す」方式は、以下2点を組み合わせた実装として成立する。  
1) RuntimeがAuthorizationヘッダをagent codeへ受け渡せる。  
2) Gateway呼び出しでAuthorizationヘッダ付きMCP接続が可能。
- 上記は公式の個別機能を組み合わせた実装方針であり、本仕様ではこの方式を正式採用する。
