# KinTrain

空いているマシン優先で筋トレを継続するための記録アプリです。  
トレーニング実施、Daily記録、カレンダー確認、AIコーチチャットUIを提供します。

## 実装状況

- フロントエンド: 実装済み（React + Vite + TypeScript）
- 認証: 実装済み（Amazon Cognito / アクセストークン認可）
- MCPユーザー境界: Gateway REQUEST Interceptorでアクセストークンを再検証し、JWT `sub` をサーバー側で強制
- Core API: 実装済み（API Gateway + Lambda分割）
- DynamoDB: 実装済み（モデル別テーブル）
- AI Runtime/Gateway/Memory: 実装済み（環境変数 `ENABLE_AGENTCORE_RESOURCES=true` のブランチで有効）

## 主な機能

- ログイン / ログアウト
- 初回ログイン時の新パスワード設定、パスワード再設定
- トレーニング実施記録
  - 重量・回数・セット入力
  - 種目表示は `トレーニング名 : 部位`（部位未設定時はトレーニング名のみ）
  - 下書き自動保存 / リロード復元
  - セット詳細入力
  - 「前回と同じ」「入力クリア」
- トレーニングメニュー管理
  - 追加・更新・削除・並び替え
  - 鍛える部位（`bodyPart`）の設定
  - 回数レンジ（`defaultRepsMin/defaultRepsMax`）
- Daily記録
  - 体重・体脂肪率・測定時刻
  - 体調/気分（10段階）・コメント・日記・その他運動
  - 自動保存（3秒デバウンス）+ 明示保存ボタン
- カレンダー表示（月次、実施日/体調アイコン、当日ハイライト）
- AIチャット（AgentCore RuntimeへのSSE接続。Runtime未設定時のみモック応答へフォールバック）
- AIメニュー生成（対話で提案を調整し、MCP経由で新規セットとして登録）
- ユーザー／AIコーチのアバター画像アップロードと永続化
- iPhoneホーム画面追加対応（PWA manifest / standalone起動メタタグ）

注記:
- AI Runtimeが出力に含まれないローカル環境では、通常AIチャットだけモック応答へフォールバックします。AIメニュー生成はRuntime必須です。
- AIキャラクター設定とアバターはCore APIへ永続保存します。

## バックエンド構成

- IaC: `amplify/backend.ts`（Amplify Gen2 + CDK）
- 認証: Cognito User Pool / App Client
- Core API: API Gateway（Cognito authorizer + scope）
- Lambda（機能分割）
  - `profile-api`
  - `training-menu-api`
  - `training-history-api`
  - `daily-record-api`
  - `ai-settings-api`
  - `avatar-upload-api`
  - `mcp-tools-api`（AgentCore GatewayのLambda target）
- DynamoDB
  - `KinTrain-UserProfileTable-{branch}`
  - `KinTrain-TrainingMenuTable-{branch}`
  - `KinTrain-TrainingMenuSetTable-{branch}`
  - `KinTrain-TrainingMenuSetItemTable-{branch}`
  - `KinTrain-TrainingHistoryTable-{branch}`
  - `KinTrain-TrainingPerformanceTable-{branch}`
  - `KinTrain-DailyRecordTable-{branch}`
  - `KinTrain-GoalTable-{branch}`
  - `KinTrain-AiSettingTable-{branch}`
  - `KinTrain-AiAdviceLogTable-{branch}`

## ローカル実行

```bash
npm ci
npm run dev
```

## デプロイ方式（GitHub push → Amplify）

デプロイ操作はGitHubへのpushだけです。Amplify Hostingが `main` / `dev` を監視し、pushされたコミットに対して `amplify.yml` を実行して、バックエンドとフロントエンドを一括デプロイします。ローカルからAWSへデプロイしません。

### 必須運用ルール（固定）

- 開発作業は必ず `dev` ブランチで行う。
- `git push origin dev` でAmplifyのdev環境を自動デプロイし、動作確認する。
- dev確認後に変更を `main` へ取り込み、mainのコミットをGitHubへpushする。Amplifyが本番環境を自動デプロイする。
- `main` 上で直接開発せず、必ずdevで検証したコミットを反映する。
- `ampx sandbox`、`scripts/deploy-backend.sh`、`scripts/deploy-frontend.sh`、`aws s3 sync` はmain/devのデプロイには使用しない。

構築・デプロイ・ロールバック・動作確認の正本は [`docs/deployment.md`](docs/deployment.md) を参照してください。

### Branch Deploy運用の注意

- Amplifyが提供する `AWS_BRANCH` により、main/devのリソース名を分離します。
- `AMPLIFY_IDENTIFIER`、`FRONTEND_S3_BUCKET`、ローカルAWS認証情報はデプロイに使用しません。
- DynamoDB物理名は `KinTrain-{モデル名}-{branch}` として明示し、`main` と `dev` を分離します。
- 機密情報（AWSキー等）はGitHubに置かないでください。

### Amplifyで設定する環境変数

Amplify Console の `アプリ設定 > 環境変数` で設定します。ブランチ名はAmplifyの `AWS_BRANCH` を使用するため、`AMPLIFY_BRANCH` の手動設定は不要です。

AgentCoreを利用するブランチで必須:

- `ENABLE_AGENTCORE_RESOURCES`  
  `true` で AgentCore Runtime/Gateway/Memory を作成。`false` で作成しない。
- `AI_COACH_GATEWAY_NAME`（省略時はブランチ名から生成）
  例: `kintrain-ai-coach-gateway-dev`
- `AI_COACH_MEMORY_NAME`（省略時はブランチ名から生成）
  例: `kintrainCoachMemory_dev`
- `AI_COACH_RUNTIME_NAME`（省略時はブランチ名から生成）
  例: `kintrainCoachRuntime_dev`

AI Runtime設定（任意、未指定時はデフォルト値）:

- `MODEL_ID`  
  例: `global.anthropic.claude-sonnet-5`
- `APP_TIMEZONE_DEFAULT`  
  例: `Asia/Tokyo`
- `ENABLE_MCP_TOOLS`  
  `true` / `false`
- `ENABLE_WEB_SEARCH_TOOL`  
  `true` / `false`
- `WEB_SEARCH_PROVIDER`  
  `tavily` または `exa`
- `TAVILY_API_KEY` / `EXA_API_KEY`
  現行コードはRuntime環境変数へ渡す実装のため、利用前にSecrets Manager参照へ移行すること。値をリポジトリへ保存しない。

既存Runtimeを使う場合のみ:

- `AI_RUNTIME_ENDPOINT_URL`  
  AgentCoreリソースを新規作成せず、既存Runtimeエンドポイントを参照する場合に設定

## 補足

`amplify.yml` は Amplify Gen2 Fullstack Branch Deployment 用に構成済みです。

## 主要ドキュメント

- 要件定義: `docs/spec.md`
- UI仕様: `docs/ui-spec.md`
- AI実装仕様: `docs/ai-implementation-spec.md`
- MCPユーザー境界セキュリティ設計: `docs/mcp-security-design.md`
- MCP体重・体脂肪率一括登録要件: `docs/mcp-body-metrics-bulk-registration-requirements.md`
- ChatGPT MCP接続: `docs/chatgpt-mcp-connection.md`
- Claude MCP接続: `docs/claude-mcp-connection.md`
- ビルド・デプロイ手順: `docs/deployment.md`
- セキュリティレビュー: `docs/review/security-review-2026-07-12.md`
