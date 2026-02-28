# KinTrain 要件定義書（MVP）

最終更新日: 2026-02-28

## 1. 目的

ジムで空いているマシンを使う運用を前提に、トレーニング内容を簡便に記録し、長期参照とAIアドバイス/チャット相談を可能にするWebアプリを提供する。

## 2. 対象範囲

- 対象ユーザー: 個人利用（1ユーザー）
- 対応言語: 日本語
- 対応端末: スマホ/PC（レスポンシブ）
- 利用形態: オンライン前提

## 3. システム構成要件

- Frontend: Web SPA
- 配信: Amazon S3（本番配信はCloudFront併用）
- 認証: Amazon Cognito
- API: Amazon API Gateway + AWS Lambda
- データ保存: Amazon DynamoDB
- AI: Amazon Bedrock AgentCore Runtime + AgentCore Gateway（MCP）
- IaC: AWS CDK（TypeScript）

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
- `AgentExecutionSession`: AgentCore Runtime実行セッション
- `MemorySession`: AgentCore Memory上でイベントを束ねるセッション

### 4.1 AIチャットセッションの定義

- `AiChatSession` はユーザーがUIで開始する会話単位である。
- 1つの `AiChatSession` は、複数のユーザー発話/AI応答ターンを保持する。
- `AiChatSession` は以下の識別子を関連づける。
- `aiChatSessionId`（アプリ側会話ID）
- `runtimeSessionId`（AgentCore Runtimeの会話継続ID）
- `memorySessionId`（AgentCore Memoryの`sessionId`）
- `runtimeSessionId` が期限切れした場合でも、同一 `aiChatSessionId` を継続し、新しい `runtimeSessionId` を再関連付けできること。
- `memorySessionId` は同一 `AiChatSession` 内で固定し、短期記憶イベントを同一会話として蓄積すること。

### 4.2 用語の明確化（UI仕様整合）

- `TrainingMenu`: 日次固定ではない実施候補リスト。優先順位計算の入力元。
- `TrainingMenuItem`: メニュー内の1項目（トレーニング名、既定重量/回数/セット、手動順序）。
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

- メールアドレス+パスワードでサインアップ/ログインできること。
- ログイン済みユーザーのみAPI利用可能であること。

### 5.2 トレーニングメニュー管理

- ユーザーは `TrainingMenuItem` を追加/編集/無効化/並び替えできること。
- `TrainingMenuItem` は以下を保持すること。
- `trainingMenuItemId`
- `trainingName`
- `defaultWeightKg`
- `defaultReps`
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
- `weightKg`
- `reps`
- `sets`
- `performedAtUtc`（RFC3339 UTC、秒精度）
- `rpe`（任意）
- `note`（任意）
- `weightKg > 0`、`reps > 0`、`sets > 0` を満たすこと。
- `0` は有効値として扱わないこと（削除マーカーとしても使用しない）。
- 前日実施トレーニングを参照できること。

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
- `bodyMetricMeasuredAtUtc`（RFC3339 UTC）
- `bodyMetricMeasuredAtLocal`（RFC3339 + offset）
- `bodyMetricMeasuredTimeLocal`（`HH:mm`、UI入力値）
- `timeZoneId`（IANA、例: `Asia/Tokyo`）
- 体調5段階評価（1:最悪, 5:最高）
- 体調コメント（任意）
- 日記（任意）
- その他トレーニング（フリー入力、複数可）
- アイコンタップのみで体調評価を即記録できること（コメント入力なし可）。
- `DailyRecord` は後から更新できること。
- `bodyMetricMeasuredTimeLocal` が入力された場合、サーバーは `date` + `timeZoneId` と組み合わせて `bodyMetricMeasuredAtLocal/UTC` を生成して保存すること。

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
- AiChatSessionはRuntimeのセッション期限切れ後も継続できること（必要に応じてRuntimeセッションを再生成）。
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
- 変更内容は `PUT /ai-character-profile` でユーザー単位に保存する。
- 未設定時は `nyaruko` 既定値へフォールバックする。

## 6. API要件（CoreApiEndpoint: API Gateway）

- `GET /me/profile`
- `PUT /me/profile`
- `GET /training-menu-items`
- `GET /training-session-view?date=YYYY-MM-DD`
- `POST /training-menu-items`
- `PUT /training-menu-items/{trainingMenuItemId}`
- `DELETE /training-menu-items/{trainingMenuItemId}`（論理削除）
- `PUT /training-menu-items/reorder`
- `POST /gym-visits`
- `GET /gym-visits?from=YYYY-MM-DD&to=YYYY-MM-DD`
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

- `TrainingMenuItem` レスポンスモデル:
- `trainingMenuItemId: string`
- `trainingName: string`
- `defaultWeightKg: number`（小数2桁まで）
- `defaultReps: number`
- `defaultSets: number`
- `displayOrder: number`
- `isActive: boolean`
- `lastPerformanceSnapshot`（任意）
- `lastPerformanceSnapshot.performedAtUtc: RFC3339 UTC`
- `lastPerformanceSnapshot.weightKg: number`
- `lastPerformanceSnapshot.reps: number`
- `lastPerformanceSnapshot.sets: number`
- `lastPerformanceSnapshot.visitDateLocal: YYYY-MM-DD`
- `createdAt: RFC3339 UTC`
- `updatedAt: RFC3339 UTC`
- `POST /training-menu-items` リクエスト:
- `trainingName`
- `defaultWeightKg`
- `defaultReps`
- `defaultSets`
- `PUT /training-menu-items/{trainingMenuItemId}` リクエスト:
- `trainingName`
- `defaultWeightKg`
- `defaultReps`
- `defaultSets`
- `isActive`（任意）
- `PUT /training-menu-items/reorder` リクエスト:
- `items: [{ trainingMenuItemId, displayOrder }]`
- `GET /training-session-view?date=YYYY-MM-DD` レスポンス:
- `items: [{ trainingMenuItemId, trainingName, defaultWeightKg, defaultReps, defaultSets, displayOrder, lastPerformanceSnapshot }]`
- `todayDoneTrainingMenuItemIds: string[]`

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

#### 7.3.1 TrainingMenuテーブル

- テーブル名: `KinTrainTrainingMenu`
- 主キー:
- `PK = USER#{userId}`
- `SK = <MENU_ENTITY>#...`
- 代表SK:
- `TRAINING_MENU_ITEM#{trainingMenuItemId}`
- `TRAINING_MENU_NAME#{normalizedTrainingName}`（同一ユーザー内の一意制約用）
- 主な属性:
- `trainingMenuItemId`
- `trainingName`
- `defaultWeightKg`
- `defaultReps`
- `defaultSets`
- `displayOrder`
- `isActive`
- `lastPerformanceSnapshotPerformedAtUtc`（任意）
- `lastPerformanceSnapshotWeightKg`（任意）
- `lastPerformanceSnapshotReps`（任意）
- `lastPerformanceSnapshotSets`（任意）
- `lastPerformanceSnapshotVisitDateLocal`（任意）
- `createdAt`
- `updatedAt`

#### 7.3.2 TrainingHistoryテーブル

- テーブル名: `KinTrainTrainingHistory`
- 主キー:
- `PK = USER#{userId}`
- `SK = <HISTORY_ENTITY>#...`
- 代表SK:
- `GYM_VISIT_DATE#{visitDateLocal}#VISIT#{visitId}`
- `GYM_VISIT_ID#{visitId}`
- `EXERCISE_ENTRY#{visitId}#{entryId}`
- `GYM_VISIT` 主な属性:
- `visitId`
- `startedAtUtc`
- `endedAtUtc`
- `timeZoneId`
- `visitDateLocal`
- `performedTrainingMenuItemIds: string[]`（当日実施種目ID集合）
- `entrySummaries: [{ trainingMenuItemId, trainingNameSnapshot, weightKg, reps, sets, performedAtUtc }]`
- `EXERCISE_ENTRY` 主な属性:
- `entryId`
- `visitId`
- `trainingMenuItemId`
- `trainingNameSnapshot`
- `weightKg`
- `reps`
- `sets`
- `performedAtUtc`
- `setDetails`（任意）
- `GSI1PK`
- `GSI1SK`
- `GYM_VISIT_DATE#...` と `GYM_VISIT_ID#...` は同一内容を冗長保持し、`TransactWriteItems` で同時更新する。

#### 7.3.3 UserDataテーブル

- テーブル名: `KinTrainUserData`
- 主キー:
- `PK = USER#{userId}`
- `SK = <USER_ENTITY>#...`
- 代表SK:
- `PROFILE`
- `DAILY_RECORD#{yyyy-MM-dd}`
- `GOAL#CURRENT`
- `AI_CHARACTER_PROFILE`
- `AI_CHAT_SESSION#{chatSessionId}`
- `AI_CHAT_MESSAGE#{chatSessionId}#{timestamp}`
- `AI_ADVICE#{timestamp}#{adviceId}`
- `AI_CHARACTER_PROFILE` には `characterId`, `characterName`, `avatarImageUrl`, `tonePreset`, `updatedAt` を保持する。
- `AI_CHARACTER_PROFILE` が未作成のユーザーは `assets/characters/nyaruko/character-profile.json` を既定として扱う。

### 7.4 日付・時刻フォーマット規約（共通）

- TimeZoneは IANA形式で保持する（例: `Asia/Tokyo`）。
- 日付のみ項目は `YYYY-MM-DD`（ローカル日付）を使用する。
- 時刻付き項目は RFC3339 を使用し、秒を必須とする（`YYYY-MM-DDTHH:mm:ssZ` 形式を正本とする）。
- UTC保存: `YYYY-MM-DDTHH:mm:ssZ`（例: `2026-02-28T05:12:30Z`）
- ローカル表示用: `YYYY-MM-DDTHH:mm:ss+09:00`（例: `2026-02-28T14:12:30+09:00`）
- トレーニング実施データ（`GymVisit.startedAtUtc` / `GymVisit.endedAtUtc` / `ExerciseEntry.performedAtUtc`）は必ずRFC3339 UTCで保存する。
- API入力でオフセット付き日時を受け取った場合、サーバー側でUTCへ正規化して保存する。
- `DailyRecord` の日付キーは `timeZoneId` 基準のローカル日付で決定する。
- AIに渡す時刻コンテキストは `timeZoneId` / `nowUtc` / `nowLocal` を必須にする。
- AIがDynamoDBの時刻を扱う際は、必ず `timeZoneId` 基準のローカル時刻へ変換してから日付判定・助言を行うこと。
- AI判断でUTCのみを根拠に日付解釈しないこと。

### 7.5 GSI設計（すべてuserIdを含む）

- `TrainingHistory.GSI1`（TrainingMenuItem履歴検索）
- `GSI1PK = USER#{userId}`
- `GSI1SK = TRAINING_MENU_ITEM#{trainingMenuItemId}#PERFORMED_AT#{yyyy-MM-ddTHH:mm:ssZ}#VISIT#{visitId}#ENTRY#{entryId}`
- 用途: `trainingMenuItemId` 単位で過去履歴を時系列取得

- `UserData.GSI2`（チャットセッション一覧）
- `GSI2PK = USER#{userId}`
- `GSI2SK = CHAT#UPDATED_AT#{timestamp}#SESSION#{chatSessionId}`
- 用途: AIチャットセッションを新しい順に取得

### 7.6 アクセスパターンとクエリ設計（Scan禁止）

- AP-01 プロファイル取得（UserData）: `GetItem(PK=USER#{sub}, SK=PROFILE)`
- AP-02 プロファイル更新（UserData）: `UpdateItem(PK=USER#{sub}, SK=PROFILE)`
- AP-03 トレーニングメニュー一覧（TrainingMenu）: `Query PK=USER#{sub} AND begins_with(SK, 'TRAINING_MENU_ITEM#')`
- AP-04 トレーニングメニュー作成（TrainingMenu）: `TransactWriteItems`（`TRAINING_MENU_ITEM` と `TRAINING_MENU_NAME` を同時作成、`TRAINING_MENU_NAME` は `attribute_not_exists(PK)` で重複拒否）
- AP-05 トレーニングメニュー更新（TrainingMenu）: `TransactWriteItems`（名称変更時は旧 `TRAINING_MENU_NAME` 削除 + 新 `TRAINING_MENU_NAME` 作成 + `TRAINING_MENU_ITEM` 更新）
- AP-06 トレーニングメニュー削除（TrainingMenu）: `TransactWriteItems`（`TRAINING_MENU_ITEM.isActive=false` 更新 + `TRAINING_MENU_NAME` 削除）
- AP-07 トレーニングメニュー並び替え（TrainingMenu）: `TransactWriteItems` で複数 `TRAINING_MENU_ITEM` の `displayOrder` を更新
- AP-08 GymVisit日付範囲（TrainingHistory）: `Query PK=USER#{sub} AND SK BETWEEN 'GYM_VISIT_DATE#{from}#' AND 'GYM_VISIT_DATE#{to}#~'`
- AP-09 GymVisit詳細（TrainingHistory）: `GetItem(PK=USER#{sub}, SK=GYM_VISIT_ID#{visitId})`（`entrySummaries` を含む単一Item）
- AP-10 前日実施トレーニング（TrainingHistory）: AP-08で前日範囲を取得し、各Itemの `performedTrainingMenuItemIds` を集合化
- AP-11 TrainingMenuItem別履歴（TrainingHistory.GSI1）: `Query GSI1PK=USER#{sub} AND GSI1SK BETWEEN 'TRAINING_MENU_ITEM#{trainingMenuItemId}#PERFORMED_AT#' AND 'TRAINING_MENU_ITEM#{trainingMenuItemId}#PERFORMED_AT#~'`（最新1件は `ScanIndexForward=false` + `Limit=1`）
- AP-12 DailyRecord範囲（UserData）: `Query PK=USER#{sub} AND SK BETWEEN 'DAILY_RECORD#{from}' AND 'DAILY_RECORD#{to}~'`
- AP-13 DailyRecord単日取得（UserData）: `GetItem(PK=USER#{sub}, SK=DAILY_RECORD#{date})`
- AP-14 DailyRecord単日更新（UserData）: `PutItem(PK=USER#{sub}, SK=DAILY_RECORD#{date})`
- AP-15 月次カレンダー表示（UserData + TrainingHistory）: AP-12で体調、AP-08で実施有無を取得して合成
- AP-16 AIキャラクター設定取得（UserData）: `GetItem(PK=USER#{sub}, SK=AI_CHARACTER_PROFILE)`
- AP-17 AIキャラクター設定更新（UserData）: `PutItem(PK=USER#{sub}, SK=AI_CHARACTER_PROFILE)`
- AP-18 目標値取得（UserData）: `GetItem(PK=USER#{sub}, SK=GOAL#CURRENT)`
- AP-19 AIチャットメッセージ（UserData）: `Query PK=USER#{sub} AND begins_with(SK, 'AI_CHAT_MESSAGE#{chatSessionId}#')`
- AP-20 AIチャットセッション一覧（UserData.GSI2）: `Query GSI2PK=USER#{sub} AND begins_with(GSI2SK, 'CHAT#')`（GSI2）
- AP-21 AIアドバイス履歴（UserData）: `Query PK=USER#{sub} AND begins_with(SK, 'AI_ADVICE#')`
- AP-22 実施画面初期表示（Core API）:
- 1) `Query TrainingMenu`（AP-03）で `TrainingMenuItem` と `LastPerformanceSnapshot` を取得
- 2) `Query TrainingHistory`（AP-08）を `from=date,to=date` で実行し、`performedTrainingMenuItemIds` から `todayDoneTrainingMenuItemIds` を作成
- AP-23 GymVisit確定保存時:
- 1) `TrainingHistory` へ `GYM_VISIT` / `EXERCISE_ENTRY` を `TransactWriteItems`
- 2) 各 `trainingMenuItemId` の `lastPerformanceSnapshot*` を `TrainingMenu` 側へ `UpdateItem`
- 3) これにより実施画面の「直近実績」をN件個別Queryせずに取得可能とする
- AP-24 Daily画面当日詳細（Core API）:
- 1) `GetItem DailyRecord`（AP-13）
- 2) `Query TrainingHistory`（AP-08）を `from=date,to=date` で実行
- 3) `entrySummaries` を時刻順に整形して当日筋トレ内容として返却

### 7.7 クエリ上限・ページング規約（コスト制御）

- `scan` は禁止（全API/全Lambda）。
- 日付範囲Queryは必ず上限を設ける。
- `GET /calendar?month=YYYY-MM` は対象月のみ（最大31日）。
- `GET /gym-visits?from&to` は `to-from <= 31日` を上限とする。
- `GET /training-session-view?date=YYYY-MM-DD` は対象日1日分のみ取得する。
- AI用途の履歴取得は `days <= 90` かつ `limit <= 100` を上限とする。
- 一覧系APIは `limit` と `nextToken`（または `lastEvaluatedKey`）でページング可能にする。
- `GET /training-menu-items` は `limit <= 200` を上限とする。
- `GET /gym-visits?from&to` は `limit <= 100` を上限とし、ページング必須とする。
- `GET /daily-records?from&to` は `limit <= 62` を上限とし、ページング必須とする。
- AIチャット履歴取得（AP-19/AP-20）は `limit <= 100` を上限とし、ページング必須とする。
- 1リクエストで返す最大件数（既定）:
- `trainingMenuItems`: 100件
- `gymVisits`: 50件
- `exerciseEntries`: 100件
- `dailyRecords`: 62件
- 上限超過時は 400 を返却する（クライアントに範囲再指定を促す）。

## 8. セキュリティ要件

- API GatewayはCognito JWT Authorizerで保護すること。
- Runtime -> Gateway -> LambdaはIAM最小権限で接続すること。
- 他ユーザーのデータ参照は不可能であること。

## 9. AgentCore Runtime / Gateway 要件

### 9.1 Runtime

- `CoachAgent` をRuntimeに配置し、会話制御と応答生成を行うこと。
- `CoachAgent` の役割名（表示/設定上の正本）は `AIコーチ` とすること。
- `AgentExecutionSession` を保持し、会話継続性を提供すること。

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

### 9.3 連携方式

- RuntimeがGateway経由でMCPツールを呼び出し、DynamoDBの記録を参照してAdvice/Chatを生成すること。

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
- `/dashboard` に `トレーニング開始` と `本日の日記をつける` 導線を設けること。
- トレーニング一覧は日次固定ではなく履歴ベースで優先順表示すること。
- 一覧行で `重量/回数/セット` を直接入力できること。
- `前回と同じ` のワンクリック入力を提供すること。
- 各種目に `入力クリア` を提供し、当該種目を `TrainingSessionDraft` から削除できること。
- セット詳細入力はオプション表示（初期非表示）とすること。
- 途中入力はリロード後も復元されること（ドラフト保存）。
- 「記録して終了」を押した時のみ正式記録すること。
- 画面は時刻を `timeZoneId` 基準でローカライズ表示し、`timeZoneId` 文字列の常時表示は不要とする。
- `/ai-chat` でAIキャラクターアイコンと名前を表示し、発話主体が視覚的に分かること。

## 11. 開発プロセス要件（モックUI先行）

- 実装はモックUIから開始すること。
- フロー:
- 画面モック作成（APIはモックデータ）
- 操作確認・レビュー
- 要件確定
- バックエンド実装開始
- レビュー完了まで本実装（API/Lambda/DynamoDB/AgentCore接続）を開始しないこと。

## 12. 受け入れ基準

- GymVisit/ExerciseEntryの作成・更新・削除が可能であること。
- 「トレーニング名・重量・回数・セット」を保存し再参照できること。
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

- テーブル名: `PascalCase`（例: `KinTrainTrainingMenu`, `KinTrainTrainingHistory`, `KinTrainUserData`）
- パーティション/ソートキー属性名: `PK`, `SK`（大文字固定）
- GSIキー属性名: `GSI1PK`, `GSI1SK`, `GSI2PK`, `GSI2SK`（大文字固定）
- エンティティ属性名: `camelCase`（例: `createdAt`, `trainingNameSnapshot`）
- 識別子プレフィックス: 大文字スネーク風トークン + `#`（例: `USER#`, `GYM_VISIT_DATE#`）
- DynamoDB属性名にハイフンは使用しない。

## 15. 参考（公式）

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
