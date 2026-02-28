# KinTrain

ジムでの筋トレ記録を「空いているマシン優先」で継続できるようにするWebアプリです。  
トレーニング実績、Daily記録、カレンダー参照、AIコーチ相談を1つのUIで扱います。

## 現在の状態

- 要件定義/設計: ほぼ確定
- フロントエンド: モックUI完成（React + Vite + TypeScript）
- バックエンド: Amplify Gen2 + CDK の実装着手済み（初期スキャフォールド）
- AI連携: AgentCore Runtime/Gateway方針を設計済み

## 主な機能（モックUI）

- ログイン（メールアドレス + パスワード）/ ログアウト
- トレーニング実施記録（重量・回数・セット、下書き保存、セット詳細）
- トレーニングメニュー管理（追加・更新・削除・並び替え）
- Daily記録（体重・体脂肪率・測定時刻・体調・日記・その他運動）
- カレンダー表示（月次、実施日/体調アイコン）
- AIチャット画面（キャラクター表示つき、ストリーミング表示モック）

## 技術スタック（設計）

- Frontend: React SPA
- Auth: Amazon Cognito
- Core API: API Gateway + Lambda
- Data: DynamoDB
- AI: Amazon Bedrock AgentCore Runtime + AgentCore Gateway (MCP) + Memory
- IaC / Deploy: Amplify Gen2 + CDK（`backend.createStack()`）
- 配信: Amplify Hosting

## デプロイ方針

- Amplify Gen2 Fullstack Branch Deployment を標準採用
- 1回のブランチデプロイでフロントエンドとバックエンドを同時反映
- バックエンド拡張（AgentCore関連含む）はCDKカスタムリソースで管理

## 実装済みバックエンド（土台）

- `amplify/backend.ts`
- Cognito（Amplify Auth）
- API Gateway（Cognito authorizerつき）
- Core API Lambda（`amplify/functions/core-api/handler.ts`）
- DynamoDBテーブル
- `KinTrainTrainingMenu`
- `KinTrainTrainingHistory`（GSI1）
- `KinTrainUserData`（GSI2）
- `amplify.yml`（Amplifyフルスタックデプロイ設定）

## 主要ドキュメント

- 全体要件: `docs/spec.md`
- UI仕様（モック正本）: `docs/ui-spec.md`
- AI実装仕様: `docs/ai-implementation-spec.md`

## ローカルでUIモックを起動

```bash
cd frontend
npm install
npm run dev
```

ビルド確認:

```bash
cd frontend
npm run build
```

## Amplify Gen2 デプロイ（初期）

```bash
npm install
npx ampx sandbox
```

フルスタックCI/CDは `amplify.yml` を使用し、Amplify Hostingのブランチデプロイで実行します。

## 補足

- 現在のログインはモック実装です（ローカル状態保持）。
- サインアップ/メールアドレス確認は将来対応で、現時点MVPには含みません。
