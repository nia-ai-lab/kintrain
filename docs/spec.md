# KinTrain 要件定義書（MVP）

最終更新日: 2026-03-01

## 1. 目的

ジムで空いているマシンを使う運用を前提に、トレーニング内容を簡便に記録し、長期参照とAIアドバイス/チャット相談を可能にするWebアプリを提供する。

## 2. 対象範囲

- 対象ユーザー: 個人利用（1ユーザー）
- 対応言語: 日本語
- 対応端末: スマホ/PC（レスポンシブ）
- 利用形態: オンライン前提

### 2.1 実装ステータス（2026-03-01）

- 実装済み:
- Cognito認証（ログイン/ログアウト/パスワード再設定）
- Core API（API Gateway + Lambda分割）とDynamoDB CRUD
- トレーニングメニュー回数レンジ（`defaultRepsMin/defaultRepsMax`）
- Daily記録の自動保存（3秒デバウンス）+ 明示保存ボタン
- iPhoneホーム画面追加対応（manifest + standaloneメタタグ）
- AIチャットUIのSSEストリーミング
- AIキャラクター設定API（`GET/PUT /ai-character-profile`）
- AgentCore Runtime 接続（`AiRuntimeEndpoint`）
- Runtime のプロンプトファイル読込（`SOUL.md` / `PERSONA.md` / `system-prompt.ja.txt`）
- Runtime の `AgentCoreMemorySessionManager` 連携（`actorId=sub`, `sessionId=chatSessionId`）
- 未実装:
- AgentCore Gateway（MCP）経由ツール呼び出しの本番連携強化
- UIからの `PUT /ai-character-profile` 永続保存連携（現在はローカル反映）
- `bodyMetricMeasuredAtUtc/bodyMetricMeasuredAtLocal` のサーバー自動生成
- `/history` `/progress` の本実装（現状プレースホルダ）

## 3. システム構成要件

- Frontend: Web SPA
- 配信（現行）: S3静的配信（`aws s3 sync`）
- 配信（目標）: AWS Amplify Hosting（マネージドCloudFront + S3）
- 認証: Amazon Cognito
- API: Amazon API Gateway + AWS Lambda
- データ保存: Amazon DynamoDB
- AI: Amazon Bedrock AgentCore Runtime + AgentCore Gateway（MCP）
- IaC: Amplify Gen2（TypeScript）+ AWS CDKカスタムリソース
- CI/CD: Amplify Gen2 Fullstack Branch Deployments

### 3.1 デプロイ方式（フロント/バック一括反映）

- 標準デプロイ方式は Amplify Gen2 の Fullstack Branch Deployment とする。
- 標準ブランチ運用は `dev` / `main` の2系統とする（`dev`: 検証、`main`: 本番）。
- 必須フローは `dev` で実装・検証後に `main` へ反映する順序とする。
- 1回のブランチデプロイ（Git push起点）で、以下を同時に反映すること。
- バックエンド（Cognito / API Gateway / Lambda / DynamoDB / AgentCore関連リソース）
- フロントエンド（SPAビルド成果物のHosting反映）
- バックエンド拡張リソースは Amplify Gen2 の `backend.createStack()`（CDK）で管理すること。
- デプロイ単位はブランチ単位とし、フロントとバックで別タイミングの手動デプロイを標準運用にしないこと。
- 将来 custom pipeline を採用する場合でも、最終的に1回のパイプライン実行でフロント/バックが反映される設計を維持すること。

### 3.2 Core APIのサービス分割

- API Gateway は `ANY /{proxy+}` を使用せず、リソース/メソッドを明示定義する。
- Lambda は機能単位で分割する。
- `profile-api`: `/me/profile`
- `training-menu-api`: `/training-menu-items` 系
- `training-history-api`: `/gym-visits`, `/training-session-view`
- `daily-record-api`: `/daily-records`, `/calendar`
- `ai-settings-api`: `/ai-character-profile`

## 4. ドメイン定義（ユビキタス言語）

- `User`: 認証済み利用者
- `CoreApiEndpoint`: UIがトレーニング記録・マシン管理・体組成管理のCRUDを呼び出すAPI Gatewayエンドポイント
- `AiRuntimeEndpoint`: UIがAIチャット/提案生成を呼び出すAgentCore Runtimeエンドポイント
- `GymVisit`: ジム来館1回分の記録
- `ExerciseEntry`: GymVisit内の1種目記録（例: チェストプレス 22.5kg 12回 3セット）
- `TrainingHistory`: 確定済みトレーニング実施履歴の集合（`GymVisit` + `ExerciseEntry`）
- `LastPerformanceSnapshot`: 各 `TrainingMenuItem` の直近実績を保持する読取最適化用サマリ
- `BodyMetric`: 体重・体脂肪率の記録
- `DailyRecord`: 日付単位の総合記録（体重/体脂肪率、体調、日記、その他トレーニング）
- `OtherActivity`: フリー入力のその他トレーニング記録（例: ジョギング1km）
- `Goal`: 目標体重・目標体脂肪率
- `Advice`: AI提案結果
- `ChatThread`: AI相談履歴
- `AiChatSession`: UI上の1会話スレッドを表すAIチャットセッション（複数ターンで構成）
- `AiAgentRole`: AIエージェントの機能上の役割名（本アプリでは固定で `AIコーチ`）
- `AiCharacterProfile`: AIチャット表示用キャラクター設定（キャラクターID・名前・アイコン・口調プリセット）
- `ChatSessionId`: UIが払い出し、Runtime `sessionId` と Memory `session_id` に共通で利用する会話セッション識別子

### 4.1 AIチャットセッションの定義

- `AiChatSession` はユーザーがUIで開始する会話単位である。
- 1つの `AiChatSession` は、複数のユーザー発話/AI応答ターンを保持する。
- `AiChatSession` は単一の `chatSessionId` を持つ。
- `chatSessionId` は以下で同一値を使用する。
- UIアプリの会話スレッドID
- AgentCore Runtime invoke の `sessionId`
- AgentCore Memory の `session_id`
- 画面リロード後も同一 `chatSessionId` を復元し、会話を継続できること。
- `新規チャット` 操作時のみ新しい `chatSessionId` を払い出し、新規会話を開始すること。

### 4.2 用語の明確化（UI仕様整合）

- `TrainingMenu`: 日次固定ではない実施候補リスト。優先順位計算の入力元。
- `TrainingMenuItem`: メニュー内の1項目（トレーニング名、鍛える部位、既定重量/回数/セット、手動順序）。
- `TrainingMenu` と `TrainingHistory` の違い:
- `TrainingMenu` は「これから実施する計画値（既定値/順序）」を管理するモデル。
- `TrainingHistory` は「実際に実施した結果（重量/回数/セット/時刻）」を保持するモデル。
- `TrainingMenu` は編集されると値が変わるが、`TrainingHistory` は事実履歴として保持する。
- `LastPerformanceSnapshot` は `TrainingHistory` を正本としつつ、`TrainingMenu` 側に冗長保持する読取専用情報である。
- `TrainingSession`: ジム滞在中に行う記録作業（未確定状態を含むUI上の作業単位）。
- `TrainingSessionDraft`: `TrainingSession` の途中保存データ。正式記録前の一時状態。
- `GymVisit`: `記録して終了` 後に確定した筋トレ実績（永続データ）。
- `DailyRecord`: 1日単位の総合記録（体組成、体調、日記、その他トレーニング、当日実績サマリ）。
- `BodyMetric`: `DailyRecord` 内の体組成サブ情報（独立永続の主オブジェクトではない）。
- `Daily` 画面: `DailyRecord` を表示/更新するUI画面。ドメインオブジェクト名ではない。
- `ConditionRating`: 体調評価の離散値（1〜5）。

## 5. 機能要件

### 5.1 認証

- メールアドレス+パスワードでログインできること（MVP）。
- ログイン済みユーザーのみAPI利用可能であること。
- Core API の認可トークンは Cognito **アクセストークン**（JWT）を必須とし、IDトークンは認可に使用しないこと。
- ユーザーはログアウトできること。
- サインアップ/メールアドレス確認は将来機能として扱い、MVPには含めないこと。

### 5.2 トレーニングメニュー管理

- ユーザーは `TrainingMenuItem` を追加/編集/無効化/並び替えできること。
- `TrainingMenuItem` は以下を保持すること。
- `trainingMenuItemId`
- `trainingName`
- `bodyPart`（任意、鍛える部位）
- `defaultWeightKg`
- `defaultRepsMin`
- `defaultRepsMax`
- `defaultSets`
- `displayOrder`
- `isActive`
- `trainingName` は同一ユーザー内で一意であること。

### 5.3 トレーニング記録

- ユーザーはGymVisitを作成/更新/削除できること。
- GymVisitにExerciseEntryを複数登録できること。
- GymVisitは以下の日時項目を保持すること。
- `startedAtUtc`（RFC3339 UTC、秒精度）
- `endedAtUtc`（RFC3339 UTC、秒精度）
- `timeZoneId`（IANA、例: `Asia/Tokyo`）
- `visitDateLocal`（`timeZoneId` 基準のローカル日付、`YYYY-MM-DD`）
- ExerciseEntryは以下を保持すること。
- `trainingMenuItemId`
- `trainingNameSnapshot`
- `bodyPartSnapshot`（任意、保存時点の部位名スナップショット）
- `weightKg`
- `reps`
- `sets`
- `performedAtUtc`（RFC3339 UTC、秒精度）
- `rpe`（任意）
- `note`（任意）
- `weightKg > 0`、`reps > 0`、`sets > 0` を満たすこと。
- `0` は有効値として扱わないこと（削除マーカーとしても使用しない）。
- 前日実施トレーニングを参照できること。
- UIの種目表示は `トレーニング名 : 部位` とし、`bodyPart` 未設定時はトレーニング名のみ表示すること。

### 5.4 履歴参照

- 日付範囲でGymVisit履歴を検索できること。
- TrainingMenuItem別の履歴を参照できること。
- 長期履歴を継続参照できること。

### 5.5 体組成管理

- 体重・体脂肪率を日次記録できること。
- 目標体重・目標体脂肪率を保持できること。
- 体組成推移を参照できること。

### 5.6 Daily記録管理

- 日付ごとに `DailyRecord` を記録/更新できること。
- `DailyRecord` は以下を保持できること。
- `bodyWeightKg`（任意）
- `bodyFatPercent`（任意）
- `bodyMetricMeasuredTimeLocal`（`HH:mm`、UI入力値）
- `timeZoneId`（IANA、例: `Asia/Tokyo`）
- 体調5段階評価（1:最悪, 5:最高）
- 体調コメント（任意）
- 日記（任意）
- その他トレーニング（フリー入力、複数可）
- アイコンタップのみで体調評価を即記録できること（コメント入力なし可）。
- `DailyRecord` は後から更新できること。
- 現行実装では `bodyMetricMeasuredTimeLocal` と `timeZoneId` を保存する。
- `bodyMetricMeasuredAtUtc` / `bodyMetricMeasuredAtLocal` のサーバー自動生成は次フェーズで実装する。

### 5.7 カレンダー参照

- 1ヶ月単位カレンダーで「筋トレ実施日」のみ識別できること。
- カレンダーセルに体調評価（5段階）をアイコン表示できること。
- 日付タップで `Daily` 画面へ遷移できること。
- `Daily` 画面で当日の筋トレ内容、体重・体脂肪率、日記、体調、その他トレーニングを確認/更新できること。
- カレンダー上で体調評価を視覚的に確認できること（色またはアイコン）。

### 5.8 AIアドバイス/チャット

- AIエージェントの役割名は `AIコーチ` とする（固定）。
- キャラクター表示名は役割名と分離する（既定: `ニャル子`）。
- 記録データと目標値を参照したAdviceを生成できること。
- ChatThread上で継続相談できること。
- AiChatSession単位で会話を継続できること。
- 会話継続の識別子は `chatSessionId` で統一し、同一会話内ではIDを変更しないこと。
- AI機能は `AiRuntimeEndpoint`（AgentCore Runtime）経由で提供すること。
- AIのシステムプロンプトはプログラムへハードコードせず、コードとは別のテキストファイルで管理すること。
- AI回答は一般的助言のみとし、医療診断は行わないこと。
- `AiCharacterProfile` を設定できること（`characterId`、キャラクター名、アイコン、口調プリセット）。
- AIチャット画面で、設定したキャラクターが話しているように表示できること。
- AIチャット画面の表示名は `{characterName}` とすること（例: `ニャル子`）。
- `AiCharacterProfile` の保持項目:
- `characterId`
- `characterName`
- `avatarImageUrl`
- `tonePreset`
- 既定キャラクターは `nyaruko` を使用すること。
- 既定設定ファイル:
- `assets/characters/nyaruko/character-profile.json`
- 既定アイコン画像:
- `assets/characters/nyaruko/expressions/default.png`
- 感情別の表情画像はMVP仕様に含めないこと。
- キャラクター設定方法:
- 初回表示時は `GET /ai-character-profile` を取得し、未設定時は上記ファイルを読み込む。
- ユーザーは `/settings` の「AIコーチキャラクター設定」で変更する。
- Core API は `PUT /ai-character-profile` を提供する。
- 現行UIの「AI設定を反映」はローカル状態更新のみで、`PUT` 呼び出し連携は次フェーズで実装する。
- 未設定時は `nyaruko` 既定値へフォールバックする。

## 6. API要件（CoreApiEndpoint: API Gateway）

- `GET /me/profile`
- `PUT /me/profile`
- `GET /training-menu-items`
- `GET /training-session-view?date=YYYY-MM-DD`
- `POST /training-menu-items`
- `PUT /training-menu-items/{trainingMenuItemId}`
- `DELETE /training-menu-items/{trainingMenuItemId}`（物理削除）
- `PUT /training-menu-items/reorder`
- `POST /gym-visits`
- `GET /gym-visits?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=n`（`from/to` は任意）
- `GET /gym-visits/{visitId}`
- `PUT /gym-visits/{visitId}`
- `DELETE /gym-visits/{visitId}`
- `GET /calendar?month=YYYY-MM`
- `GET /daily-records/{date}`（`date`: `YYYY-MM-DD`）
- `GET /daily-records?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `PUT /daily-records/{date}`（`date`: `YYYY-MM-DD`）
- `GET /ai-character-profile`
- `PUT /ai-character-profile`
- `GET /goals`
- `PUT /goals`

### 6.1 AI Runtime呼び出し要件（AiRuntimeEndpoint）

- UIはAIチャット/提案生成を `AiRuntimeEndpoint` の `InvokeAgentRuntime` で実行すること。
- API Gateway配下に `/ai/*` エンドポイントは設けないこと。

### 6.2 トレーニングメニューAPIデータモデル

- `GET /training-menu-items` の `TrainingMenuItem` レスポンスモデル:
- `trainingMenuItemId: string`
- `trainingName: string`
- `bodyPart: string`（任意。未設定時は空文字）
- `defaultWeightKg: number`（小数2桁まで）
- `defaultRepsMin: number`
- `defaultRepsMax: number`
- `defaultReps: number`（後方互換のため任意で返却される場合あり）
- `defaultSets: number`
- `displayOrder: number`
- `isActive: boolean`
- `createdAt: RFC3339 UTC`
- `updatedAt: RFC3339 UTC`
- `POST /training-menu-items` リクエスト:
- `trainingName`
- `bodyPart`（任意）
- `defaultWeightKg`
- `defaultRepsMin`
- `defaultRepsMax`
- `defaultReps`（任意、後方互換）
- `defaultSets`
- `PUT /training-menu-items/{trainingMenuItemId}` リクエスト:
- `trainingName`
- `bodyPart`（任意）
- `defaultWeightKg`
- `defaultRepsMin`
- `defaultRepsMax`
- `defaultReps`（任意、後方互換）
- `defaultSets`
- `isActive`（任意）
- `PUT /training-menu-items/reorder` リクエスト:
- `items: [{ trainingMenuItemId, displayOrder }]`
- `GET /training-session-view?date=YYYY-MM-DD` レスポンス:
- `items: [{ trainingMenuItemId, trainingName, bodyPart, defaultWeightKg, defaultRepsMin, defaultRepsMax, defaultSets, displayOrder, lastPerformanceSnapshot }]`
- `todayDoneTrainingMenuItemIds: string[]`
- `lastPerformanceSnapshot`（任意）:
- `performedAtUtc: RFC3339 UTC`
- `bodyPartSnapshot: string`（任意）
- `weightKg: number`
- `reps: number`
- `sets: number`
- `visitDateLocal: YYYY-MM-DD`
- UI表示で種目名を組み立てる場合は `trainingName` と `bodyPart`（または `bodyPartSnapshot`）を使用し、`トレーニング名 : 部位` 形式で表示すること。

### 6.3 UIモック項目名とのマッピング

- UIモックのローカル状態名とAPI入出力名は以下を対応させること。
- `menuItem.id` <-> `trainingMenuItemId`
- `menuItem.order` <-> `displayOrder`
- `dailyRecord.bodyMetricMeasuredTime` <-> `bodyMetricMeasuredTimeLocal`
- UI実装は上記マッピングで吸収し、DynamoDB/Backend正本はAPI名を使用すること。

## 7. データ要件

- 保存先: DynamoDB（モデル別テーブル分割）
- `TrainingMenu` モデルと `TrainingHistory` モデルは物理テーブルを分離する
- ユーザー分離: 全テーブル/全GSIで `userId` をパーティションキーに含める
- データ保持: 無期限
- 単位: 重量はkg
- 既定タイムゾーン: `Asia/Tokyo`
- `scan` は実行しない（`GetItem` / `Query` のみ使用）

### 7.1 userIdの定義

- `userId` は Cognito アクセストークンの `sub` を使用する。
- 理由:
- 不変で一意であり、メールアドレスやユーザー名変更の影響を受けないため。
- API Gateway/LambdaでJWT検証後、`sub` をサーバー側で取り出して利用する。

### 7.2 ユーザ属性情報

- ユーザ属性は `PROFILE` アイテムで管理する。
- 必須項目:
- `userId`（= sub）
- `userName`（ユーザ名）
- `heightCm`（身長）
- `birthDate`（生年月日、`YYYY-MM-DD`）
- `timeZoneId`（IANA、例: `Asia/Tokyo`）
- 推奨項目:
- `sex`
- `createdAt`
- `updatedAt`

### 7.3 DynamoDB物理設計（モデル別テーブル）

#### 7.3.1 UserProfileテーブル

- テーブル名: CloudFormation自動命名（論理ID: `UserProfileTable`）
- 主キー:
- `userId`（パーティションキー、Cognito `sub`）
- 主な属性:
- `userName`
- `sex`
- `birthDate`
- `heightCm`
- `timeZoneId`
- `createdAt`
- `updatedAt`

#### 7.3.2 TrainingMenuテーブル

- テーブル名: CloudFormation自動命名（論理ID: `TrainingMenuTable`）
- 主キー:
- `userId`（パーティションキー）
- `trainingMenuItemId`（ソートキー）
- 主な属性:
- `trainingName`
- `bodyPart`
- `normalizedTrainingName`
- `defaultWeightKg`
- `defaultRepsMin`
- `defaultRepsMax`
- `defaultSets`
- `displayOrder`
- `isActive`
- `createdAt`
- `updatedAt`
- GSI:
- `UserDisplayOrderIndex`（`userId`, `displayOrder`）
- `UserTrainingNameIndex`（`userId`, `normalizedTrainingName`）

#### 7.3.3 TrainingHistoryテーブル

- テーブル名: CloudFormation自動命名（論理ID: `TrainingHistoryTable`）
- 主キー:
- `userId`（パーティションキー）
- `visitId`（ソートキー）
- 主な属性:
- `startedAtUtc`
- `endedAtUtc`
- `timeZoneId`
- `visitDateLocal`
- `entries: ExerciseEntry[]`
- `note`
- `createdAt`
- `updatedAt`
- GSI:
- `UserStartedAtIndex`（`userId`, `startedAtUtc`）

#### 7.3.4 DailyRecordテーブル

- テーブル名: CloudFormation自動命名（論理ID: `DailyRecordTable`）
- 主キー:
- `userId`（パーティションキー）
- `recordDate`（ソートキー、`YYYY-MM-DD`）
- 主な属性:
- `bodyWeightKg`
- `bodyFatPercent`
- `bodyMetricMeasuredAtUtc`
- `bodyMetricMeasuredAtLocal`
- `bodyMetricMeasuredTimeLocal`
- `timeZoneId`
- `conditionRating`
- `conditionComment`
- `diary`
- `otherActivities`
- `createdAt`
- `updatedAt`

#### 7.3.5 AiSettingテーブル

- テーブル名: CloudFormation自動命名（論理ID: `AiSettingTable`）
- 主キー:
- `userId`（パーティションキー）
- 主な属性:
- `characterId`
- `characterName`
- `avatarImageUrl`
- `tonePreset`
- `createdAt`
- `updatedAt`

### 7.4 日付・時刻フォーマット規約（共通）

- TimeZoneは IANA形式で保持する（例: `Asia/Tokyo`）。
- 日付のみ項目は `YYYY-MM-DD`（ローカル日付）を使用する。
- 時刻付き項目は RFC3339 を使用し、秒を必須とする（`YYYY-MM-DDTHH:mm:ssZ` 形式を正本とする）。
- UTC保存: `YYYY-MM-DDTHH:mm:ssZ`（例: `2026-02-28T05:12:30Z`）
- ローカル表示用: `YYYY-MM-DDTHH:mm:ss+09:00`（例: `2026-02-28T14:12:30+09:00`）
- トレーニング実施データ（`GymVisit.startedAtUtc` / `GymVisit.endedAtUtc` / `ExerciseEntry.performedAtUtc`）は必ずRFC3339 UTCで保存する。
- 現行実装ではクライアント側でUTCへ正規化して送信し、サーバーは受信値を保存する。
- API入力でオフセット付き日時を受け取った場合のサーバー側UTC正規化は次フェーズで実装する。
- `DailyRecord` の日付キーは `timeZoneId` 基準のローカル日付で決定する。
- AIに渡す時刻コンテキストは `timeZoneId` / `nowUtc` / `nowLocal` を必須にする。
- AIがDynamoDBの時刻を扱う際は、必ず `timeZoneId` 基準のローカル時刻へ変換してから日付判定・助言を行うこと。
- AI判断でUTCのみを根拠に日付解釈しないこと。

### 7.5 GSI設計（すべてuserIdを含む）

- `TrainingMenu.UserDisplayOrderIndex`
- `userId` + `displayOrder`
- 用途: 実施順表示のためにメニューを順序で取得

- `TrainingMenu.UserTrainingNameIndex`
- `userId` + `normalizedTrainingName`
- 用途: 同一ユーザー内のトレーニング名重複チェック

- `TrainingHistory.UserStartedAtIndex`
- `userId` + `startedAtUtc`
- 用途: GymVisitを時系列で取得（一覧・期間検索・月次表示）

### 7.6 アクセスパターンとクエリ設計（Scan禁止）

- AP-01 プロファイル取得（UserProfile）: `GetItem(userId=sub)`
- AP-02 プロファイル更新（UserProfile）: `PutItem(userId=sub)`
- AP-03 トレーニングメニュー一覧（TrainingMenu）: `Query UserDisplayOrderIndex(userId=sub)`
- AP-04 トレーニングメニュー重複チェック（TrainingMenu）: `Query UserTrainingNameIndex(userId=sub, normalizedTrainingName=...)`
- AP-05 トレーニングメニュー作成（TrainingMenu）: `PutItem(userId=sub, trainingMenuItemId=uuid)`
- AP-06 トレーニングメニュー更新（TrainingMenu）: `UpdateItem(userId=sub, trainingMenuItemId=...)`
- AP-07 トレーニングメニュー削除（TrainingMenu）: `DeleteItem(userId=sub, trainingMenuItemId=...)`
- AP-08 トレーニングメニュー並び替え（TrainingMenu）: `TransactWriteItems` で複数 `displayOrder` 更新
- AP-09 GymVisit作成（TrainingHistory）: `PutItem(userId=sub, visitId=uuid)`
- AP-10 GymVisit一覧（TrainingHistory）: `Query UserStartedAtIndex(userId=sub, startedAtUtc BETWEEN fromUtc AND toUtc)`
- AP-11 GymVisit詳細（TrainingHistory）: `GetItem(userId=sub, visitId=...)`
- AP-12 GymVisit更新（TrainingHistory）: `PutItem(userId=sub, visitId=...)`
- AP-13 GymVisit削除（TrainingHistory）: `DeleteItem(userId=sub, visitId=...)`
- AP-14 DailyRecord範囲（DailyRecord）: `Query(userId=sub, recordDate BETWEEN from AND to)`
- AP-15 DailyRecord単日取得（DailyRecord）: `GetItem(userId=sub, recordDate=...)`
- AP-16 DailyRecord単日更新（DailyRecord）: `PutItem(userId=sub, recordDate=...)`
- AP-17 カレンダー（月次）: `Query DailyRecord` + `Query TrainingHistory.UserStartedAtIndex` を合成
- AP-18 AIキャラクター設定取得（AiSetting）: `GetItem(userId=sub)`
- AP-19 AIキャラクター設定更新（AiSetting）: `PutItem(userId=sub)`

### 7.7 クエリ上限・ページング規約（コスト制御）

- `scan` は禁止（全API/全Lambda）。
- 現行実装:
- `GET /training-menu-items` は `limit <= 200`（既定100）を適用し、`nextToken` でページングする。
- `GET /gym-visits` は `limit <= 200`（既定100）を適用する（`nextToken` 未実装）。
- `GET /daily-records?from&to` は範囲Queryを実行する（`limit/nextToken` 未実装）。
- `GET /calendar?month=YYYY-MM` は対象月のみ（最大31日）を取得する。
- `GET /training-session-view?date=YYYY-MM-DD` は対象日をキーに1日分を取得する。
- 次フェーズの目標:
- `GET /gym-visits` の `nextToken` ページング対応
- `GET /daily-records` の `limit/nextToken` 対応
- `from/to` の最大日数バリデーション（31日上限など）
- AI用途履歴APIの `days` / `limit` 上限制御
- 目標とする1リクエスト最大件数（将来）:
- `trainingMenuItems`: 100件
- `gymVisits`: 50件
- `exerciseEntries`: 100件
- `dailyRecords`: 62件
- 上限超過時は 400 を返却する（クライアントに範囲再指定を促す）。

## 8. セキュリティ要件

- API GatewayはCognito JWT Authorizerで保護すること。
- Core API の全メソッドは API Gateway の `authorizationScopes` を設定し、アクセストークンの `scope` で認可すること。
- MVPで必須とするスコープは `aws.cognito.signin.user.admin` とする。
- Runtime -> Gateway -> LambdaはIAM最小権限で接続すること。
- 他ユーザーのデータ参照は不可能であること。
- パブリックリポジトリ運用のため、リソース識別子（バケット名、API URL、User Pool IDなど）や認証情報をソースコード/ドキュメントへハードコードしないこと。
- 環境固有値は `.env.local` などのローカル設定ファイルで管理し、`.gitignore` でコミット除外すること。
- 公開可能なテンプレートは `.env.example` を使用すること。

## 9. AgentCore Runtime / Gateway 要件

### 9.1 Runtime

- `CoachAgent` をRuntimeに配置し、会話制御と応答生成を行うこと。
- `CoachAgent` の役割名（表示/設定上の正本）は `AIコーチ` とすること。
- `chatSessionId` をRuntime `sessionId` として保持し、会話継続性を提供すること。
- Runtime実装は Strands フレームワーク + Python を採用すること。
- モデルIDはRuntime環境変数（例: `MODEL_ID`）で切替可能にすること。

### 9.2 Gateway（MCP）

- 以下ツールをMCPとして公開すること。
- `get_recent_gym_visits(days)`
- `get_training_history(trainingMenuItemId, limit)`
- `get_daily_records(from, to)`
- `get_daily_record(date)`
- `get_goal()`
- `get_ai_character_profile()`
- `save_advice_log(advice)`
- `userId` はツール公開引数に含めず、RuntimeがJWT `sub` を内部注入すること。
- MCP Lambda はメソッド名を `context.clientContext.custom.bedrockAgentCoreToolName` から判定すること（`event` 起点で判定しない）。

### 9.3 連携方式

- RuntimeがGateway経由でMCPツールを呼び出し、DynamoDBの記録を参照してAdvice/Chatを生成すること。
- RuntimeエンドポイントのInbound認可は Cognito アクセストークン（Bearer JWT）を使用すること。
- Runtimeは受け取ったBearer JWTをGateway呼び出しへリレーし、Gateway側でも同トークンでInbound認可すること。
- UIのAIチャットはストリーミング表示とし、回答本文に加えて進行状態イベント（例: thinking/tool calling）も表示可能にすること。

## 10. UI要件

- 必須画面:
- `/login`
- `/dashboard`
- `/training-session`
- `/training-menu`
- `/training-menu/ai-generate`
- `/calendar`
- `/daily/:date`
- `/settings`
- `/history`
- `/progress`
- `/ai-chat`
- 詳細UI仕様は `docs/ui-spec.md` を正本とする。
- 未ログイン時は `/login` へ遷移し、認証後に保護画面へアクセスできること。
- `/dashboard` に `トレーニング開始` と `本日の日記をつける` 導線を設けること。
- トレーニング一覧は日次固定ではなく履歴ベースで優先順表示すること。
- トレーニング種目名は `トレーニング名 : 部位` 形式で表示すること（部位未設定時はトレーニング名のみ）。
- 一覧行で `重量/回数/セット` を直接入力できること。
- `前回と同じ` のワンクリック入力を提供すること。
- 各種目に `入力クリア` を提供し、当該種目を `TrainingSessionDraft` から削除できること。
- セット詳細入力はオプション表示（初期非表示）とすること。
- 途中入力はリロード後も復元されること（ドラフト保存）。
- 「記録して終了」を押した時のみ正式記録すること。
- `Daily` は入力後3秒で自動保存し、保存ボタンで即時保存もできること。
- 画面は時刻を `timeZoneId` 基準でローカライズ表示し、`timeZoneId` 文字列の常時表示は不要とする。
- `/ai-chat` でAIキャラクターアイコンと名前を表示し、発話主体が視覚的に分かること。
- iPhoneで「ホーム画面に追加」した場合、ブラウザUIのない standalone 表示で起動できること。

## 11. 開発プロセス状況（モックUI先行の結果）

- モックUI先行フローは完了し、Core API/DynamoDBの本実装へ移行済み。
- 実施済みフロー:
- 画面モック作成（UI要件調整）
- 操作確認・レビュー
- 要件確定
- Core API / Lambda / DynamoDB実装
- 未移行:
- AgentCore Runtime / Gateway / Memory の本実装（現状は設計段階）

## 12. 受け入れ基準

- メールアドレス+パスワードでログインできること（サインアップ画面はMVP対象外）。
- ログアウト後は保護画面に直接アクセスできず、`/login` へ遷移すること。
- GymVisit/ExerciseEntryの作成・更新・削除が可能であること。
- 「トレーニング名・部位・重量・回数・セット」を保存し再参照できること。
- カレンダーで日別の実施内容を確認できること。
- 体調を5段階+コメントで記録できること。
- 体調をアイコンタップのみで記録できること。
- `Daily` 画面で当日の体重・体脂肪率・日記・体調・その他トレーニングを更新できること。
- 前日実施トレーニングを当日画面で確認できること。
- 体重/体脂肪率推移を表示できること。
- AI提案カードとチャット応答が動作すること。
- AIキャラクター（名前/口調）が設定・反映できること。
- AIキャラクターアイコンは `default` 画像が表示されること。
- トレーニング実施時刻がRFC3339 UTC（秒精度）で保存され、表示/AI利用時に `timeZoneId` 基準へ変換されること。
- 不正値（重量/回数/セットが0以下）は登録できないこと。
- 他ユーザーのデータにアクセスできないこと。
- Amplify Gen2 の1回のブランチデプロイで、フロントエンドとバックエンドが同時に反映されること。

## 13. 未確定・不足要件（要決定）

- 同日複数回の来館をどう扱うか（複数GymVisitを許可するか）。
- 1 ExerciseEntry内でセットごとに重量/回数を変える仕様を許可するか。
- ウォームアップセット/ドロップセットの記録要否。
- AIアドバイスの出力形式（固定テンプレートか自由文か）。
- AIの禁止事項文面と免責文言の確定。
- 退会時のデータ削除ポリシー（無期限保持との整合）。
- 運用環境（dev/stg/prod）とAWSリージョンの確定。
- 性能目標値（API p95、画面表示時間）の数値確定。
- モックUIレビューの合格条件（必須シナリオと承認者）の確定。

## 14. 共通命名規則

### 14.1 基本方針

- 本プロジェクトの標準は `camelCase` とする（TypeScript/JavaScriptで最も一般的なため）。
- `snake_case` は標準として採用しない。例外は環境変数など外部慣習が強い項目のみ。

### 14.2 プログラム命名

- 変数/関数/メソッド/プロパティ: `camelCase`
- 型/クラス/インターフェース/列挙型: `PascalCase`
- 定数/環境変数: `UPPER_SNAKE_CASE`
- 真偽値: `is` / `has` / `can` で開始する（例: `isActive`）

### 14.3 ファイル命名

- 通常ファイル名: `kebab-case`（例: `gym-visit-service.ts`）
- Reactコンポーネントファイル: `PascalCase` を許可（例: `GymVisitCard.tsx`）
- テストファイル: `<name>.test.ts` / `<name>.test.tsx`
- AIシステムプロンプトファイル: `config/prompts/system-prompt.ja.txt`
- AIエージェント設定ファイル（固定名）: `config/prompts/PERSONA.md`, `config/prompts/SOUL.md`

### 14.4 API命名

- URLパス: `kebab-case`（例: `/gym-visits`）
- クエリパラメータ: `camelCase`
- JSONのキー: `camelCase`

### 14.5 DynamoDB命名

- テーブル名: 物理名はCloudFormation自動命名を使用し、論理IDは `PascalCase`（例: `TrainingMenuTable`, `TrainingHistoryTable`）
- パーティション/ソートキー属性名はドメイン語彙を使用する（例: `userId`, `trainingMenuItemId`, `visitId`, `recordDate`）
- GSIキー属性名もドメイン語彙を使用する（例: `displayOrder`, `normalizedTrainingName`, `startedAtUtc`）
- エンティティ属性名: `camelCase`（例: `createdAt`, `trainingNameSnapshot`）
- DynamoDB属性名にハイフンは使用しない。

## 15. 参考（公式）

- Amplify Gen2 Fullstack Branch Deployments  
  https://docs.amplify.aws/react/deploy-and-host/fullstack-branching/branch-deployments/
- Amplify Gen2 Custom Resources（CDK / `backend.createStack()`）  
  https://docs.amplify.aws/angular/build-a-backend/add-aws-services/custom-resources/
- Amplify Gen2 Custom Pipelines（`pipeline-deploy` / `generate outputs`）  
  https://docs.amplify.aws/nextjs/deploy-and-host/fullstack-branching/custom-pipelines/
- Bedrock AgentCore GA（2025-10-13）  
  https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-bedrock-agentcore-generally-available/
- AgentCore Runtime ドキュメント  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime.html
- AgentCore Gateway ドキュメント  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html
- Gateway targets（Lambda/API等）  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-targets.html
- Bedrock Responses API と AgentCore Gateway連携（2026-02-24）  
  https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-bedrock-responses-api-agentcore-gateway/
