# ClaudeからKinTrain MCP Gatewayへ接続する

## 1. 目的

ClaudeのリモートMCPカスタムコネクタから、Amazon Bedrock AgentCore GatewayのKinTrain MCP endpointへ接続する。ユーザー認証には既存のKinTrain Cognito User Poolを使用し、OAuth Authorization Code flow + PKCEでCognitoアクセストークンを発行する。

Claude用Cognito App Clientは、フロントエンド用およびChatGPT用App Clientから分離する。同じUser Poolを使うためユーザーとJWT `sub` は共通だが、Client ID、Client Secret、Callback URL、失効・ローテーションの影響範囲は独立する。

## 2. 対象

本書はClaude.ai、Claude Desktop、Claudeモバイル、Coworkから利用するリモートカスタムコネクタを対象とする。

Claude Codeはローカルの可変ポートへCallbackするため、本書の固定Callback URLを使う接続方式とは異なる。

## 3. AWS側の構成

- Cognito User Pool: 既存KinTrain User Poolを共用
- Cognito Managed Login domain: ChatGPT接続で作成済みのドメインを共用
- Cognito App Client: ブランチごとにClaude専用Clientを作成
  - `KinTrain-Claude-dev`
  - `KinTrain-Claude-main`
- Client Secret: あり
- OAuth flow: Authorization Code Grantのみ
- Callback URL:

```text
https://claude.ai/api/mcp/auth_callback
```

- OAuth scopes:
  - `openid`
  - `email`
  - `profile`
  - `aws.cognito.signin.user.admin`
- Access / ID token: 1時間
- Refresh token: 30日
- Token revocation: 有効

Callback URLはClaudeのホスト型クライアントで固定されているため、ChatGPTのような二段階設定やAmplify環境変数は不要である。

## 4. Claude側の設定

Claudeの `Customize > Connectors` からカスタムコネクタを追加する。Team / EnterpriseではOwnerが組織設定から追加し、各ユーザーが個別に接続する。

```text
Name: KinTrain Dev または KinTrain
Remote MCP server URL: amplify_outputs.json の custom.endpoints.aiGatewayUrl
Authentication: OAuth
OAuth Client ID: amplify_outputs.json の custom.claudeOAuth.clientId
OAuth Client Secret: Cognito Claude用App Clientのsecret
```

Client IDとClient Secretは `Advanced settings` に入力する。AgentCore GatewayはDynamic Client Registrationを提供しないため、Claudeの自動登録には依存せず、事前登録した固定Client IDとSecretを使用する。

MCP URLにはすでに `/mcp` が含まれるため、追加で `/mcp` を付けない。

## 5. Client Secretの取得

物理Client IDはAmplify出力から取得し、Client Secretは対象User Poolを指定して取得する。Secretをログ、Issue、チャット、ドキュメント、リポジトリへ保存しない。

```bash
aws cognito-idp describe-user-pool-client \
  --region ap-northeast-1 \
  --user-pool-id <branch-user-pool-id> \
  --client-id <custom.claudeOAuth.clientId> \
  --query 'UserPoolClient.ClientSecret' \
  --output text
```

## 6. 認証・ユーザー境界

Claude用App Clientが発行したアクセストークンは、Gateway REQUEST Interceptorの許可Client ID一覧に含める。

Interceptorは次を検証する。

1. Cognito署名とissuer
2. `token_use=access`
3. Claude用Client ID
4. 有効期限
5. `aws.cognito.signin.user.admin` scope
6. JWT `sub`

検証済み`sub`だけを内部引数`__principalUserId`としてMCP Lambdaへ渡し、Claudeやモデルが指定したユーザー識別子は認可根拠にしない。

## 7. デプロイ後の確認

1. `amplify_outputs.json`に`custom.claudeOAuth.clientId`が出力される。
2. Cognito Claude用App ClientにCallback URLが完全一致で登録される。
3. MCP URLへ未認証でアクセスすると401になる。
4. `WWW-Authenticate`にProtected Resource Metadataと必須scopeが含まれる。
5. Claudeのカスタムコネクタ追加でCognito Managed Loginへ遷移する。
6. ログイン後にMCP `initialize`と`tools/list`が成功する。
7. 本人のデータだけ取得・更新できる。
8. ChatGPTの既存接続が継続して動作する。

## 8. 参照

- Claude Connector Authentication:
  - https://claude.com/docs/connectors/building/authentication
- Claude Custom Connector:
  - https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Amazon Cognito App Client:
  - https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html
- KinTrain MCPユーザー境界:
  - `docs/mcp-security-design.md`
