# KinTrain

空いているマシン優先で筋トレを継続するための記録アプリです。  
トレーニング実施、Daily記録、カレンダー確認、AIコーチチャットUIを提供します。

## 実装状況

- フロントエンド: 実装済み（React + Vite + TypeScript）
- 認証: 実装済み（Amazon Cognito / アクセストークン認可）
- Core API: 実装済み（API Gateway + Lambda分割）
- DynamoDB: 実装済み（モデル別テーブル）
- AI Runtime/Gateway/Memory: 設計済み、未実装

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
  - 体調（5段階）・コメント・日記・その他運動
  - 自動保存（3秒デバウンス）+ 明示保存ボタン
- カレンダー表示（月次、実施日/体調アイコン、当日ハイライト）
- AIチャットUI（キャラクター表示つき、モックストリーミング）
- iPhoneホーム画面追加対応（PWA manifest / standalone起動メタタグ）

注記:
- AIチャット応答は現時点でモックです。
- AIキャラクター設定API（`/ai-character-profile`）は実装済みですが、UIは現在ローカル反映のみです。

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
- DynamoDB
  - `UserProfileTable`（物理名はCloudFormation自動命名）
  - `TrainingMenuTable`（物理名はCloudFormation自動命名）
  - `TrainingHistoryTable`（物理名はCloudFormation自動命名）
  - `DailyRecordTable`（物理名はCloudFormation自動命名）
  - `GoalTable`（物理名はCloudFormation自動命名）
  - `AiSettingTable`（物理名はCloudFormation自動命名）

## ローカル実行

```bash
npm install
npm run frontend:dev
```

## 推奨デプロイ方式（main/dev Branch Deploy）

今後の標準運用は、Amplify Hosting の Fullstack Branch Deployment（`main`/`dev`）です。  
ローカルの `sandbox + s3 sync` は補助用途として扱います。

### あなたが次にやる手順

1. GitHubブランチを用意する

```bash
git checkout -b dev
git push -u origin dev
git checkout main
git push -u origin main
```

2. Amplify Console でこのGitHubリポジトリを接続する
- Hosting type は SSR ではなく通常の Web app（このアプリはSPA）を選択
- Build settings はリポジトリの `amplify.yml` を使用

3. `main` と `dev` を両方 Branch Deploy 対象にする
- `main`: 本番
- `dev`: 検証

4. それぞれを Fullstack branch として有効化する
- フロントエンド + バックエンドを同時デプロイ
- 既存 `amplify.yml` の `ampx pipeline-deploy` を利用

5. GitHub保護ルールを設定する
- `main` 直push禁止（PR必須）
- 推奨: `feature/* -> dev -> main`

6. 動作確認
- `dev` へコミットして検証環境が更新されること
- `main` へマージして本番環境が更新されること

### Branch Deploy運用の注意

- Branch Deploy運用では `AMPLIFY_IDENTIFIER` は使用しません（sandbox専用）。
- `tableName` は未指定のため、`main` と `dev` で DynamoDB物理テーブルは分離されます。
- 機密情報（AWSキー等）はGitHubに置かないでください。

## ローカル手動デプロイ（任意）

### 1. 前提

- AWSアカウントとデプロイ権限（Cognito/API Gateway/Lambda/DynamoDB/S3）
- Node.js 20+ / npm 10+
- AWS CLI v2

### 2. セキュア設定ファイル作成（必須）

本リポジトリでは、固有情報（バケット名、プロファイル名、識別子等）をハードコードしません。  
`.env.local` に設定してください（`.gitignore` でコミット除外）。

```bash
cp .env.example .env.local
```

`.env.local` の例:

```ini
AWS_PROFILE=your-aws-profile
AWS_REGION=ap-northeast-1
AMPLIFY_IDENTIFIER=dev
FRONTEND_S3_BUCKET=your-frontend-bucket-name
```

### 3. 依存関係インストール

```bash
cd /path/to/KinTrain
npm install
```

### 4. AWS認証確認

```bash
aws sts get-caller-identity
```

### 5. バックエンド反映（sandbox）

```bash
./scripts/deploy-backend.sh
```

### 6. フロントエンド反映（S3）

```bash
./scripts/deploy-frontend.sh
```

### 7. 手動で実行したい場合（任意）

```bash
npx ampx sandbox --once --identifier "$AMPLIFY_IDENTIFIER"
npx ampx generate outputs
cp amplify_outputs.json frontend/src/amplify_outputs.json
npm run frontend:build
aws s3 sync frontend/dist "s3://$FRONTEND_S3_BUCKET" --delete
```

補足:
- `--delete` はS3側の不要ファイルを削除します。
- `amplify_outputs.json` / `frontend/src/amplify_outputs.json` は環境固有ファイルのためgit管理しません。

## 補足

`amplify.yml` は Amplify Gen2 Fullstack Branch Deployment 用に構成済みです。

## 主要ドキュメント

- 要件定義: `docs/spec.md`
- UI仕様: `docs/ui-spec.md`
- AI実装仕様: `docs/ai-implementation-spec.md`
