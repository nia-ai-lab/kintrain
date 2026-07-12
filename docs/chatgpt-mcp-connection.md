# ChatGPT から KinTrain MCP Gateway へ接続する

更新日: 2026-07-12

## 1. 概要

ChatGPTのDeveloper mode appから、Amazon Bedrock AgentCore GatewayのMCP endpointへ接続する。ユーザー認証にはKinTrainのCognito User Poolを使用し、OAuth Authorization Code flow + PKCEでCognitoアクセストークンを発行する。

ChatGPT用App Clientはフロントエンド用App Clientと分離する。Gateway REQUEST Interceptorは両Client IDをallowlistで検証し、JWT `sub` をDynamoDBのユーザー境界として使用する。

ここでいう「ChatGPT用App Client」はCognito User Pool内のOAuthクライアントであり、ChatGPT画面で作成する「プラグイン」とは別のリソースである。

- Cognito App Client: OAuth認可コードとトークンを発行するためのAWS側クライアント
- ChatGPTプラグイン: MCP URL、OAuth Client ID、Client Secretを保持するChatGPT側の接続設定
- KinTrainフロント用App Client: 既存Webフロントのログインに使用する別クライアント

同じUser Poolを使うためユーザーとJWT `sub` は共通だが、Client ID、Client Secret、Callback URL、許可する認証フローは分離される。ChatGPT用App Clientの追加によって既存KinTrainフロントのClient IDやログインフローは変更されない。

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
Client authentication method: client_secret_basic（選択欄がある場合）
```

MCP URLにはすでに `/mcp` が含まれるため、追加で `/mcp` を付けない。

**Client Secretは必須である。** Client IDだけを設定すると、CognitoログインとCallback URLへの認可コード返却に成功しても、ChatGPTがCognito token endpointで認可コードをアクセストークンへ交換できず、「接続で失敗しました」と表示される。

ChatGPT側で新規プラグインを作り直すと、`https://chatgpt.com/connector/oauth/{callback_id}` の`callback_id`が変わる可能性がある。既存設定を修正できる場合は新規作成せず、Client Secretなどの不足項目を既存設定へ追加する。新規作成した場合は、新しいCallback URLを対象環境へ登録して再デプロイする。

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

### 7.1 2026-07-12のdev実機確認

次の一連のフローをdev環境で確認済みである。

1. Cognito Managed Loginへ遷移
2. devテストユーザーでサインイン
3. ChatGPT個別Callback URLへ認可コードとstateを返却
4. `client_secret_basic`とPKCE verifierを使用してtoken endpointでトークン交換
5. Refresh tokenを含むトークン応答を取得
6. アクセストークンを付けてMCP `initialize`を実行
7. GatewayからHTTP 200とMCP server informationを取得

未認証のMCP `initialize`はHTTP 401となり、`WWW-Authenticate`に`resource_metadata`と必須scopeが含まれることも確認済みである。

## 8. 現在の環境値

2026-07-12時点の値。Client Secretは表やドキュメントへ記載しない。

| 項目 | dev | main |
|---|---|---|
| User Pool ID | `ap-northeast-1_oz34bAEh4` | `ap-northeast-1_u0xVQoljo` |
| フロント用Client ID | `4g6v8qvp7pm4s10i4j0e3s4dkh` | `51bm5fhmcp3hv8ov9gt8op2ttm` |
| ChatGPT用Client ID | `314fqvquaath5ko8hg46odr0tq` | `6pcvc6lbad1j7jhoec3ejp14li` |
| Managed Login domain | `kintrain-dev-335723620954.auth.ap-northeast-1.amazoncognito.com` | `kintrain-main-335723620954.auth.ap-northeast-1.amazoncognito.com` |
| MCP URL | `https://kintrain-ai-coach-gateway-dev-bft1uo2hbx.gateway.bedrock-agentcore.ap-northeast-1.amazonaws.com/mcp` | `https://kintrain-ai-coach-gateway-main-gvetam7c1r.gateway.bedrock-agentcore.ap-northeast-1.amazonaws.com/mcp` |
| 新形式Callback URL | `https://chatgpt.com/connector/oauth/c-hG_Kur9ZTq` | `https://chatgpt.com/connector/oauth/LIpdX-qtZ3N0` |
| 旧形式Callback URL | 登録済み | 登録済み |

mainへコードとCognito ChatGPT用App Client、および上表の新形式Callback URLはデプロイ済みである。main用プラグインを作り直してCallback URLが変わった場合は、次の順序で更新する。

1. mainのMCP URLとChatGPT用Client IDでプラグイン作成を開始する。
2. ChatGPTが表示するmain用Callback URLを控える。
3. Amplify mainブランチの`CHATGPT_OAUTH_CALLBACK_URLS`へ設定する。
4. mainを再デプロイする。
5. Client Secretを設定し、OAuth接続を完了する。

## 9. ChatGPT側に失敗したプラグインが残った場合

接続確認中に作成に失敗しても、ChatGPTの「プラグイン → 個人 → 自分で作成」にレコードが残る場合がある。2026-07-12時点のProアカウントUIでは、この状態の個人プラグイン詳細に「インストール」しか表示されず、編集・削除操作が提供されないケースを確認した。

この状態では、同名プラグインを繰り返し作成しない。まず既存設定でClient Secret、Client ID、MCP URL、Callback URLを確認する。UIから削除できない孤立レコードはChatGPT側のデータであり、KinTrainのAWSリソースやCognito App Clientを削除しても消えない。必要に応じて、対象プラグイン詳細URLから確認できるplugin IDをOpenAIサポートへ伝えて削除を依頼する。アカウント固有のplugin IDはリポジトリへ記録しない。

## 10. トラブルシューティング

| 症状 | 主な確認箇所 |
|---|---|
| `BadRequest` / operationを理解できない | MCP URL末尾が`/mcp`であること、GatewayがMCP Streamable HTTPを処理できるデプロイであること |
| Cognitoログイン前に失敗 | Protected Resource Metadata、OIDC discovery、Client ID、MCP URL |
| Cognitoログイン画面でredirect mismatch | ChatGPTが表示した新形式Callback URLが対象Cognito App Clientに完全一致で登録されているか |
| ログイン後に「接続で失敗しました」 | Client Secretの設定、`client_secret_basic`、Callback URL、PKCE token交換 |
| Gateway/Lambdaログが一切増えない | MCP到達前のOAuth discovery、認可、token交換を確認する |
| Gatewayが401を返す | JWT issuer、期限、Client ID allowlist、`WWW-Authenticate`ヘッダー |
| 接続できるが別ユーザーのデータが見える／本人データが見えない | InterceptorがJWT `sub`を内部`userId`へ設定しているか、DynamoDB partition keyとの対応 |

## 11. 参照

- OpenAI: https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- OpenAI OAuth: https://developers.openai.com/apps-sdk/build/auth
- Amazon Cognito PKCE: https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html
- Amazon Cognito resource binding: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html
