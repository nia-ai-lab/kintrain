# MCP ユーザー境界セキュリティ設計

更新日: 2026-07-12  
対象: AgentCore Runtime / Gateway / REQUEST Interceptor / MCP Lambda target  
実装コミット: `cf9114a`  
適用環境: Amplify `dev` / `main`

## 1. 目的

MCPツールが参照・更新するDynamoDBデータを、Cognitoで認証された本人の領域へ必ず限定する。モデルが生成した引数、ユーザー発話、外部コンテンツ、会話Memoryは認可根拠として扱わない。

ユーザー識別子の唯一の正は、Cognito **アクセストークン**を署名検証して得たJWT `sub` とする。DynamoDBではこの値を `userId` として使用する。

## 2. 信頼境界

```text
Browser
  | Authorization: Bearer <Cognito access token>
  v
AgentCore Runtime
  | 同じAuthorization headerをMCP接続へ中継
  v
AgentCore Gateway
  | Inbound JWT authorizer
  v
Gateway REQUEST Interceptor
  | JWTを再検証し、subを内部引数へ注入
  v
MCP Lambda target
  | __principalUserIdのみを採用
  v
DynamoDB (userId = verified sub)
```

信頼する値:

- REQUEST InterceptorがCognitoアクセストークンを検証して取得した `sub`
- Interceptorが生成した内部専用引数 `__principalUserId`

信頼しない値:

- MCP公開schemaやモデルが生成した `userId` / `actorId`
- 呼び出し元が直接指定した `__principalUserId`
- ユーザー発話、システムプロンプト、Web検索結果、Memoryに含まれるユーザー識別子
- 署名検証していないJWT payload

## 3. リクエスト処理

### 3.1 RuntimeからGateway

RuntimeはUIから受け取ったCognitoアクセストークンを、GatewayへのMCP接続で `Authorization: Bearer <token>` として中継する。モデルへトークンを渡さず、ログにもトークン値を出力しない。

### 3.2 REQUEST Interceptor

Gatewayは `passRequestHeaders=true` でREQUEST Interceptorへリクエストヘッダーを渡す。Interceptorは `tools/call` に対して次を実行する。

1. `Authorization` ヘッダーからBearer tokenを取得する。
2. `aws-jwt-verify` でCognitoアクセストークンを検証する。
3. User Pool、App Client、署名、有効期限、`token_use=access` を検証する。
4. `aws.cognito.signin.user.admin` scopeを必須とする。
5. JWT `sub` が空でないことを確認する。
6. 呼び出し元が内部専用 `__principalUserId` を指定していた場合は、値にかかわらず403を返す。
7. 互換入力の `userId` / `actorId` が存在し、JWT `sub` と異なる場合は403を返す。
8. 公開引数から `userId` / `actorId` を削除し、検証済み `sub` を `__principalUserId` として注入する。

認証ヘッダーの欠落・JWT検証失敗は401、identityの不一致・偽装は403とし、MCP Lambda targetは呼び出さない。

`tools/list` など `tools/call` 以外のMCPリクエストはidentity注入なしで通過させる。

### 3.3 MCP Lambda target

MCP Lambdaは `event.__principalUserId` だけをユーザー識別子として採用する。値がなければ403を返す。`event.userId`、`event.actorId`、Gateway context、モデル出力へのfallbackは禁止する。

すべてのDynamoDB `Get` / `Query` / `Put` / transactionで、`__principalUserId`をテーブルの `userId` に使用する。

## 4. MCP公開schema

全MCPツールの公開schemaから次のidentity引数を除外する。

- `userId`
- `actorId`
- `__principalUserId`

`__principalUserId`はGatewayとLambda間だけの内部実装詳細であり、モデルに公開しない。新しいMCPツールを追加する場合もidentity引数をschemaへ追加してはならない。

## 5. 判定表

| 入力状態 | Interceptorの処理 | 結果 |
|---|---|---|
| 有効JWT、identity引数なし | `sub`を内部注入 | targetを実行 |
| 有効JWT、`userId`が`sub`と一致 | 公開引数を削除し`sub`を内部注入 | targetを実行 |
| 有効JWT、`userId`または`actorId`が不一致 | targetをshort-circuit | 403 |
| 有効JWT、`__principalUserId`を直接指定 | targetをshort-circuit | 403 |
| JWTなし／無効／期限切れ／scope不足 | targetをshort-circuit | 401 |
| `tools/call`以外 | bodyを変更せず通過 | MCP処理を継続 |

## 6. 実装箇所

- Gateway / Lambda環境変数 / IAM接続: `amplify/backend.ts`
- REQUEST Interceptor: `amplify/functions/mcp-identity-interceptor/handler.ts`
- Interceptor resource定義: `amplify/functions/mcp-identity-interceptor/resource.ts`
- MCP Lambdaのidentity採用: `amplify/functions/mcp-tools-api/handler.ts`
- MCP公開schema: `amplify/agentcore/tool-schemas/mcp-tools.json`
- 回帰テスト: `tests/mcp-identity-interceptor.test.ts`

## 7. 検証要件

変更時は最低限、次を確認する。

1. 有効JWTでidentity引数なしのtool callが本人データを取得できる。
2. JWT `sub`と異なる `userId` / `actorId` を指定すると403になる。
3. `__principalUserId`の直接指定が403になる。
4. JWTなし・無効JWTが401になる。
5. 全公開tool schemaにidentity引数が存在しない。
6. MCP Lambdaが `__principalUserId` 以外へfallbackしない。
7. 別ユーザーのDynamoDBパーティションを参照・更新できない。
8. JWT、Authorization header、パスワードをCloudWatch Logsへ出力しない。

実装時の確認結果:

- 単体テスト9件成功
- Backend typecheck成功
- Frontend build成功
- Dev Gatewayで本人のtool call成功、不一致 `userId` の呼び出し拒否を確認
- Dev Amplify Job 12成功
- Main Amplify Job 12成功
- Dev / Main Gateway `READY`
- Main REQUEST Interceptor Lambda `Active` / update `Successful`

外部MCPクライアント用OAuth Clientを追加する場合も、フロント用、ChatGPT用、Claude用のClient IDを明示的なallowlistとしてInterceptorへ渡す。User Poolが同一でも、allowlistにないApp Clientが発行したtokenは受け入れない。ChatGPTとClaudeは別App Clientとし、Client Secret、Callback URL、失効・ローテーションの影響範囲を分離する。

## 8. 残存リスクと対象外

この修正はMCP Lambdaが使用するDynamoDB `userId` の境界を保護する。MCP Lambdaの取得レスポンスも許可フィールド方式へ変更し、内部`userId`をモデルへ返さない。

- Runtime Memoryの `actorId` は、署名検証済みclaimへ固定する必要がある（SEC-03）。
- Web取得ツールのSSRF・prompt injection対策が必要である（SEC-02）。
- 新規ツール追加時にidentity非公開とユーザー分離を自動検査するCIを導入する。

SEC-03が未解決であっても、REQUEST InterceptorはGatewayへ提示されたアクセストークンを独立して再検証するため、MCPのDynamoDB境界がモデル入力へ戻ることはない。ただしMemory境界は別途是正が必要である。
