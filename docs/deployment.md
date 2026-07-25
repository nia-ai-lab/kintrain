# KinTrain ビルド・デプロイ手順

最終更新日: 2026-07-12
正本: `amplify.yml`、`amplify/backend.ts`、GitHub `main` / `dev` ブランチ、Amplify Hostingのブランチ設定

## 1. 結論

デプロイ操作は **GitHubへのpushだけ** とする。

```text
GitHub devへpush
  → Amplify devブランチが自動ビルド
  → devバックエンド + devフロントエンドを一括デプロイ

検証済み変更をGitHub mainへ反映・push
  → Amplify mainブランチが自動ビルド
  → mainバックエンド + mainフロントエンドを一括デプロイ
```

ローカルから `ampx sandbox`、`scripts/deploy-backend.sh`、`scripts/deploy-frontend.sh`、`aws s3 sync` を実行してmain/devへデプロイしない。

## 2. 実環境で確認した設定

2026-07-12にGitHubとAWS Amplifyを照合し、次を確認した。

| 対象 | 確認結果 |
|---|---|
| GitHub repository | `nia-ai-lab/kintrain` |
| GitHub branches | `dev` / `main` |
| Amplify repository連携 | `https://github.com/nia-ai-lab/kintrain` |
| Amplify `dev` | `enableAutoBuild=true` |
| Amplify `main` | `enableAutoBuild=true`、PRODUCTION stage |
| Build specification | リポジトリの `amplify.yml` |

直近コミット `79bb677` は、GitHubへのpush後にmain/dev両方のAmplify jobで検出され、いずれも `SUCCEED` になっている。

## 3. devへのデプロイ

ローカルで検証する。

```bash
npm ci
npm run backend:typecheck
npm run frontend:build
```

変更をdevへcommitし、GitHubへpushする。

```bash
git switch dev
git add <変更ファイル>
git commit -m "変更内容"
git push origin dev
```

push後、Amplify Consoleの `kintrain` アプリでdevブランチのjobが開始される。jobが `SUCCEED` になった後、dev URLで動作確認する。

## 4. mainへのデプロイ

dev環境で確認済みの変更だけをmainへ取り込む。GitHub Pull Requestで `dev → main` をマージする方法を推奨する。ローカルで統合する場合も、main上で新規開発は行わない。

mainにマージされたコミットがGitHubへ反映されると、Amplify mainブランチのjobが自動開始される。追加のAWS CLI操作は不要。

確認事項:

- Amplify main jobが対象commit SHAを表示している
- backend phaseとfrontend phaseが成功している
- main URLでログインと主要機能を確認できる
- devとmainのDynamoDB物理名・AgentCoreリソースが分離されている

## 5. Amplifyが実行する処理

GitHub pushを検知したAmplifyは `amplify.yml` に従って次を実行する。

1. ルート依存関係を `npm ci` で固定インストール
2. AgentCore Runtime用Python依存関係をLinux ARM64向けに配置
3. `ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID` でブランチバックエンドを反映
4. ブランチの `amplify_outputs.json` を生成してフロントへコピー
5. フロントをViteでビルド
6. `frontend/dist` をAmplify Hostingへ配信

`AWS_BRANCH` と `AWS_APP_ID` はAmplifyビルド環境が提供する。ローカルの `.env.local` はデプロイに使用しない。

## 6. Amplify環境変数

アプリ設定で管理する主な値:

- `ENABLE_AGENTCORE_RESOURCES`
- `MODEL_ID`
- `APP_TIMEZONE_DEFAULT`
- `ENABLE_MCP_TOOLS`
- `CHATGPT_OAUTH_CALLBACK_URLS`
  - ChatGPT Developer mode appが発行する `https://chatgpt.com/connector/oauth/...` を設定する
  - 複数指定はカンマ区切り
  - ChatGPT接続手順は `docs/chatgpt-mcp-connection.md` を参照する
- Claude用Callback URLは固定値 `https://claude.ai/api/mcp/auth_callback` をCDKで登録するため、環境変数は不要
  - Claudeカスタムコネクタ接続手順は `docs/claude-mcp-connection.md` を参照する
- `ENABLE_WEB_SEARCH_TOOL`
- `WEB_SEARCH_PROVIDER`
- 必要に応じて `AI_COACH_GATEWAY_NAME` / `AI_COACH_MEMORY_NAME` / `AI_COACH_RUNTIME_NAME`

ブランチ名にはAmplify提供の `AWS_BRANCH` を使用し、`AMPLIFY_BRANCH` を手動設定しない。シークレットをGitHubへcommitしない。現行の外部検索APIキーはAmplify環境変数にあるため、セキュリティレビュー記載のとおりSecrets Manager参照へ移行する。

## 7. デプロイ後確認

- Amplify jobのcommit SHAがGitHubへpushしたcommitと一致する
- backend/frontend両phaseが成功する
- 未認証のCore APIとAI Runtimeが401になる
- Cognitoログイン後、プロフィール、メニュー、実施記録、Daily、AI設定を読書きできる
- AgentCore有効環境ではAIチャットのSSE応答とMCP参照が動作する
- ChatGPT / Claude接続環境では、Cognito認可コード取得、Client Secretを使ったtoken交換、MCP `initialize`が成功する
- CloudWatch LogsへJWT、APIキー、日記本文などの機微情報が出ていない

## 8. ロールバック

履歴を書き換えるforce pushは使用しない。問題のcommitをrevertしてdevへpushし、Amplify dev環境で復旧を確認する。そのrevertをmainへ取り込み、mainへpushして本番を戻す。

DynamoDBや移行処理を伴う変更は、コードのrevertだけで戻さない。PITRから復元先テーブルを作成して検証し、データ切替手順を別途作成する。
