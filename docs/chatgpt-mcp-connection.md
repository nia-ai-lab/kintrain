# ChatGPT から KinTrain MCP Gateway へ接続する

更新日: 2026-07-12

## 1. 概要

ChatGPTのDeveloper mode appから、Amazon Bedrock AgentCore GatewayのMCP endpointへ接続する。ユーザー認証にはKinTrainのCognito User Poolを使用し、OAuth Authorization Code flow + PKCEでCognitoアクセストークンを発行する。

ChatGPT用App Clientはフロントエンド用App Clientと分離する。Gateway REQUEST Interceptorは両Client IDをallowlistで検証し、JWT `sub` をDynamoDBのユーザー境界として使用する。

## 2. 前提

- 対象ブランチで `ENABLE_AGENTCORE_RESOURCES=true`
- ChatGPTでDeveloper modeを利用できること
- ChatGPTの書込みを含むFull MCP機能を使う場合は対応するBusiness / Enterprise / Edu workspaceであること
- MCP接続先は `amplify_outputs.json` の `custom.endpoints.aiGatewayUrl`
- OAuth Client IDは `amplify_outputs.json` の `custom.chatGptOAuth.clientId`
- Client Secretは出力やGitへ保存しない。必要時にAWS CLIまたはAWS Consoleから取得する

## 3. AWS側の構成

`amplify/backend.ts` はブランチごとに次を作成する。

- Cognito Managed Login domain: `kintrain-{branch}-{aws-account-id}`
- ChatGPT専用Cognito App Client
- Authorization Code grant
- Client Secretあり
- OAuth scopes:
  - `openid`
  - `email`
  - `profile`
  - `aws.cognito.signin.user.admin`
- Access / ID token: 1時間
- Refresh token: 30日
- Token revocation: 有効

## 4. Callback URLの二段階設定

ChatGPTの現行Callback URLは、Developer mode app作成時に次の形式で個別発行される。

```text
https://chatgpt.com/connector/oauth/{callback_id}
```

`callback_id` は事前に決められないため、初回は次の順序で設定する。

1. KinTrainをデプロイし、Managed Login domainとChatGPT用App Clientを作成する。
2. ChatGPTでDeveloper mode appの作成を開始する。
3. ChatGPTが表示したCallback URLを控える。
4. Amplifyの対象ブランチ環境変数 `CHATGPT_OAUTH_CALLBACK_URLS` にCallback URLを設定する。
5. 対象ブランチを再デプロイする。
6. ChatGPTでtool verificationとCognitoログインを実行する。

複数URLを設定する場合はカンマ区切りとする。許可する値は `https://chatgpt.com/connector/oauth/...` だけであり、それ以外はデプロイ時に拒否する。

互換用として次の旧Callback URLも常に登録するが、新規appでは個別発行URLを正とする。

```text
https://chatgpt.com/connector_platform_oauth_redirect
```

## 5. ChatGPT側の入力

Developer modeを有効にし、ChatGPTのPlugins / Apps設定からDeveloper-mode appを作成する。

```text
Name: KinTrain Dev
Description: KinTrainのトレーニング履歴、Daily記録、目標、メニューを参照・更新する
MCP server URL: amplify_outputs.json の custom.endpoints.aiGatewayUrl
Authentication: OAuth
Client ID: amplify_outputs.json の custom.chatGptOAuth.clientId
Client Secret: Cognito ChatGPT用App Clientのsecret
```

MCP URLにはすでに `/mcp` が含まれるため、追加で `/mcp` を付けない。

## 6. Client Secretの取得

物理Client IDはAmplify出力から取得し、Client Secretは対象User Poolを指定して取得する。コマンド出力をログ、Issue、チャット、ドキュメントへ貼り付けない。

```bash
aws cognito-idp describe-user-pool-client \
  --region ap-northeast-1 \
  --user-pool-id <branch-user-pool-id> \
  --client-id <custom.chatGptOAuth.clientId> \
  --query 'UserPoolClient.ClientSecret' \
  --output text
```

## 7. 検証

1. MCP URLへ未認証でアクセスすると401になる。
2. `WWW-Authenticate` に `resource_metadata` と必須scopeが含まれる。
3. Protected Resource Metadataが200で取得できる。
4. Cognito Managed Loginのauthorize endpointがログイン画面へ遷移する。
5. ChatGPTのtool verificationで全ツールが表示される。
6. Cognitoユーザーで接続後、本人のDynamoDBデータだけ取得できる。
7. 別Client ID、別ユーザーIDの偽装、内部identity直接指定が拒否される。
8. JWT、Client Secret、パスワードがCloudWatch Logsへ出力されない。

## 8. 参照

- OpenAI: https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- OpenAI OAuth: https://developers.openai.com/apps-sdk/build/auth
- Amazon Cognito PKCE: https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html
- Amazon Cognito resource binding: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html
