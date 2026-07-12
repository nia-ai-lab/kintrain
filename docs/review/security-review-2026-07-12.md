# KinTrain セキュリティレビュー報告書

実施日: 2026-07-12
対象: Reactフロントエンド、Amplify Gen 2/CDKバックエンド、Lambda、AgentCore Runtime/Gateway/Memory、依存関係、Git管理ファイル／履歴、デプロイ済みdev/main接続先

## 1. 総合判定

**要改善（CriticalのSEC-01は修正済み。HighのSEC-02・SEC-03を引き続き優先是正）**

通常のCore APIはCognito authorizerとscopeで保護され、Lambdaは検証後の `sub` をDynamoDBの `userId` に使っている。private S3、presigned upload制約、DynamoDB PITR、IAMの機能別grantなど、基礎的な防御は実装されている。未認証でCore APIとAgentCore Runtimeへアクセスした実測結果はいずれも401だった。

レビュー時に確認した「モデルが指定する `userId` をMCP Lambdaが認可根拠として採用する」問題は、Gateway REQUEST InterceptorによるJWT再検証と内部identity注入へ変更し、dev/mainへ反映済みである。現在も、Web取得を無効にした設定で汎用HTTPツールがロードされる問題と、Memory `actorId` を署名未検証JWT payloadから決定できる問題は残る。

## 2. 指摘一覧

| ID | 深刻度 | 指摘 | 影響 | 優先対応 |
|---|---|---|---|---|
| SEC-01 | Critical | MCPがモデル入力 `userId` を信頼 | 他ユーザーの履歴・Daily・目標・AI設定の参照、日記・助言ログ・AIメニューの他ユーザー領域への書込み | **修正済み（dev/main反映・検証済み）** |
| SEC-02 | High | Web取得falseでもHTTPツールが有効、URL制限なし | SSRF、metadata/credential endpoint探索、外部コンテンツによるprompt injection | 即時 |
| SEC-03 | High | 署名未検証JWTからMemory `actorId` を決定可能 | custom authorization headerを使った他ユーザーMemoryの読書き・混線 | 即時 |
| SEC-04 | High | npm本番依存に既知脆弱性9件 | XML処理、cookie、redirect等の既知脆弱性。経路により情報漏えい・DoS等 | 短期 |
| SEC-05 | Medium | APIキーをRuntime環境変数へ直接埋込み | CloudFormation、環境参照権限、診断時の露出範囲拡大 | 短期 |
| SEC-06 | Medium | API/AI入力の長さ・業務範囲検証が不十分 | DynamoDB item上限、コスト増、DoS、異常データ | 短期 |
| SEC-07 | Medium | 内部例外messageをクライアントへ返す | テーブル名、SDK詳細、内部構成の情報露出 | 短期 |
| SEC-08 | Medium | API Gateway保護・監査設定がコード上不足 | 大量リクエスト耐性とインシデント追跡性の低下 | 短期 |
| SEC-09 | Medium | SPAのCSP等セキュリティヘッダー未定義 | XSS発生時の影響拡大、clickjacking、MIME sniffing | 短期 |
| SEC-10 | Low | アバターは宣言Content-Typeのみ検証 | 非画像データ保存、画像デコーダ起因リスク、保管領域悪用 | 中期 |
| SEC-11 | Low | CORSが `*` | 任意originから認証付きAPI呼出しを試行可能。Bearer token自体は必要 | 中期 |

## 3. 重大指摘の詳細

### SEC-01: MCPのユーザー境界をモデル入力で決定していた（修正済み）

以下の「根拠」と「影響」は初回レビュー時点の状態を記録したものである。現行実装は後述の是正方式へ移行済みである。

根拠:

- `amplify/agentcore/tool-schemas/mcp-tools.json` の全9ツールが `userId` を公開し、requiredにしている。
- Runtimeはシステムプロンプトへ「tool arguments must include userId=actor_id」と文字列で指示するだけで、引数をコードで上書きしていない。
- `amplify/functions/mcp-tools-api/handler.ts` の `requireUserId()` は、Gateway contextより先に `args.userId` / `args.actorId` を採用する。
- 同LambdaにはDaily読書き、履歴・目標・AI設定参照、AIメニュー作成権限がある。

GatewayでJWTが正しく検証されても、Lambdaが「認証した本人」と「引数のuserId」が同一か検証しないため、認可は成立しない。通常のユーザー発話、キャラクター説明、Webページ内容などからtool引数を誘導できる。

対策:

1. tool schemaから `userId` / `actorId` を削除する。
2. Gateway interceptor等で検証済みJWT claimの `sub` を信頼済みcontextへ設定する。
3. MCP Lambdaは信頼済みcontextのidentityだけを必須採用し、引数にidentityがあれば拒否する。
4. 「攻撃者の有効JWT + 被害者subをtool引数」のテストを追加し、全toolで403または引数無視を確認する。
5. 修正まで、デプロイ環境の `ENABLE_MCP_TOOLS=false` またはAgentCore機能停止を検討する。

実装した是正（dev/main反映済み）:

- Gateway REQUEST Interceptorを追加し、Cognito access tokenを `aws-jwt-verify` で再検証する。
- 旧 `userId` / `actorId` がJWT `sub` と異なる場合は403でshort-circuitする。
- 一致または未指定の場合は、公開identity引数を削除して内部専用 `__principalUserId` を注入する。
- 全9 tool schemaから `userId` を削除し、MCP Lambdaは `__principalUserId` だけを採用する。
- identity注入、不一致拒否、予約引数spoof拒否、認証失敗、schema非公開を単体テストする。

実装後の信頼境界、判定表、回帰テスト要件は `docs/mcp-security-design.md` を正本とする。

検証結果:

- 単体テスト7件が成功した。
- Dev環境で有効JWTによるidentity引数なしのtool callが本人データを取得できた。
- Dev環境でJWT `sub` と異なる `userId` を指定したtool callが拒否された。
- 全9 tool schemaから `userId` / `actorId` / `__principalUserId` が非公開であることを確認した。
- Cognito `sub`、DynamoDB `userId`、Interceptorが注入するidentityが一致することを実データで確認した。
- Amplify dev Job 12、main Job 12が成功し、両Gatewayが `READY` になった。
- 実装コミット: `cf9114a` (`fix: enforce MCP user identity at gateway`)

### SEC-02: 無効化を迂回する汎用HTTPツールとSSRF

根拠:

- `ENABLE_WEB_SEARCH_TOOL` の既定はfalse。
- しかし `_load_web_search_tools()` はproviderが空または `http_request` の場合、フラグを確認せず `strands_tools.http_request` を返す。
- providerの既定値も `http_request`。
- URL scheme、DNS再解決後IP、redirect先のallow/deny制御がない。

対策:

1. 関数先頭で `ENABLE_WEB_SEARCH_TOOL` がfalseなら `[]` を返す。
2. `http_request` を直接モデルへ公開せず、HTTPS限定・host allowlist付きwrapperに置換する。
3. loopback、link-local、RFC1918、IPv6 local/private、AWS metadata/credential endpointsを、初期URLと全redirect・DNS解決後に拒否する。
4. 外部本文を「命令ではない非信頼データ」として分離し、本文を根拠にwrite系toolを実行しない。
5. Web取得とMCP write toolを同一agent turnへ同時公開しない、または書込み前にサーバー側確認トークンを要求する。

### SEC-03: 署名未検証JWTとMemoryテナント境界

根拠:

- Runtimeはallowlistに `Authorization` と `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Authorization` を含める。
- `_resolve_authorization_header()` はcustom headerを優先する。
- `_decode_jwt_payload_without_verification()` で署名・issuer・audience・expiryを検証せず、`sub` をMemory `actor_id` に使用する。
- RuntimeのInbound authorizerが検証するAuthorization headerと、アプリがactor決定に使うcustom headerが別になり得る。

攻撃者がAuthorizationには自分の有効トークン、custom headerには任意 `sub` の偽JWTを指定すると、Gateway呼出しは失敗してもMemoryのactor分離が破られる可能性がある。

対策:

- custom authorization headerをallowlistとコードから削除し、Runtime authorizerが検証したtoken/claimsだけを使用する。
- どうしてもcustom headerが必要なら、Cognito JWKSで署名、issuer、client/audience、token_use、scope、expiryを再検証し、Inbound認証identityと一致させる。
- actor間のMemory read/write分離テストを追加する。

## 4. その他の指摘

### SEC-04: 依存関係

`npm audit --omit=dev` は **9件（high 5、moderate 4）**。主な影響パッケージは `amazon-cognito-identity-js` / `js-cookie`、`fast-xml-parser` / `fast-xml-builder`、`lodash`、`react-router-dom`、`uuid`。全依存を含む監査は **71件（critical 2、high 33、moderate 32、low 4）** で、ビルド系の `handlebars`、`fast-xml-parser`、`aws-cdk-lib`、Vite等も含む。

Pythonの固定requirementsは `pip-audit` で既知脆弱性0件だった。

対策は、まず現行major内でAWS SDK、Amplify、Cognito、React Routerを更新し、`npm audit` 0件または受容済み例外だけになることを確認する。CDK/Amplify CLIはデプロイ時に実行されるため、dev dependencyでも無視しない。lockfile更新後にtypecheck、frontend build、E2E、CDK synth相当を実行する。

### SEC-05: シークレット管理

`TAVILY_API_KEY` / `EXA_API_KEY` をCDKからAgentCore Runtime環境変数へ渡す設計である。値が設定されると、環境設定とCloudFormationを閲覧できる主体へ露出する。Secrets Managerへ保存し、Runtime roleへ対象secretのreadだけを許可し、実行時取得する。

### SEC-06: 入力検証

- Dailyの日記、コメント、その他活動、タイムゾーン等に長さ・配列件数上限がない。
- Profile、AI character fieldsにenum、日付実在性、数値範囲、長さ制限が不足する。
- `parseYmd()` は書式だけを見て `2026-99-99` 等を一部経路で受理し得る。
- GymVisitのID・snapshot文字列・日時は型中心で、最大長やRFC3339実在性が弱い。
- Core APIは重量0を許可する一方、AIメニュー登録は正の重量だけを許可し、同一ドメインの検証が不一致。

API単位の最大body、文字列長、配列件数、数値範囲、enum、実在日付/RFC3339を共通schemaで検証する。

### SEC-07: エラー詳細

Runtimeは `type(exc).__name__` と `str(exc)`、MCP Lambdaは `error.message` を応答に含める。クライアントへは固定エラーコードとtrace IDだけを返し、詳細は機微情報を除去してCloudWatch Logsへ記録する。

### SEC-08〜11: AWS/Frontend hardening

実環境でもAPI Gateway stageのWAF、method throttling、access log、X-Rayは未設定で、LambdaとAgentCore log groupは保持期限なしだった。Lambdaにreserved concurrency、DLQ、KMS customer keyはない。CognitoはMFA OFF、deletion protection INACTIVE。SPA配信のcustom headersとWAFも未設定で、CSP、`frame-ancestors`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`がない。

CDKのDynamoDB grantは物理リソースを限定しているが、実roleにはコードで使用しない `dynamodb:Scan` も含まれる。Runtime roleのBedrock model invokeはresource `*`。必要actionと対象model/profileへ絞り、設計上の「Scan禁止」をIAMでも強制する。

Core APIとavatar bucketのCORSは `*`。Bearer tokenが必要なため直ちに認証回避にはならないが、配信originへ限定する。アバターはPOST policyで2 MiBとContent-Typeを制限する一方、magic bytesやデコード成功、マルウェアを確認しない。アップロード後Lambdaで再エンコードする方式が望ましい。

## 5. シークレット流出チェック

### 結果

- Git追跡対象の環境ファイルは `.env.example` のみで、値はplaceholder。
- `.env.local`、ルート／フロントの `amplify_outputs.json`、build成果物、`node_modules` は `.gitignore` 対象。
- 現在の追跡ファイルとGit全147 commitについて、AWS access key形式、private key header、GitHub/Slack/OpenAI/Google key代表形式を検索し、候補0件。
- ソース中に `TAVILY_API_KEY` / `EXA_API_KEY` という変数名はあるが、実値のハードコードは確認されなかった。
- 認証tokenをログ出力するコードは確認されず、Runtimeログもheader名だけを出力する。

### 判定

**リポジトリ内に外部流出してはいけない実シークレットは確認されなかった。** ただし正規表現・履歴検索で検出できない形式もあるため、CIへgitleaks等を追加し、push前と定期スキャンを継続する。

## 6. 確認できた有効な防御

- Core API全methodにCognito authorizerと `aws.cognito.signin.user.admin` scope。
- 通常Lambdaはauthorizer claimの `sub` をユーザーキーとして使用。
- デプロイ済み接続先への未認証GET/POSTはCore API、AgentCore Runtimeとも401。
- S3 avatar bucketはSSE-S3、Block Public Access、SSL強制。presigned POSTはkey、Content-Type、1 byte〜2 MiB、5分を制約。
- signed GETは10分。object keyは `users/{sub}/avatars/{target}/` prefixを検証。
- DynamoDBはPAY_PER_REQUEST、PITR、RemovalPolicy.RETAIN。
- LambdaのDynamoDB/S3権限は機能単位のread/write grant。
- フロントはReactMarkdownのraw HTML pluginを使わず、外部リンクに `noopener noreferrer`。
- パスワード入力はpassword typeと適切なautocompleteを使用。

## 7. AWS実環境監査

AWS CLI再認証後、ap-northeast-1のAmplify `dev` branchを読み取り中心で確認した。CloudFormation drift detectionは **IN_SYNC（drift 0）**、直近Amplify jobは成功していた。

### API Gateway

- Edge REST API、execute-api endpoint有効、resource policyなし。
- GET 11、POST 5、PUT 9、DELETE 4の全業務methodがCognito User Pool + `aws.cognito.signin.user.admin` scope。21個のOPTIONSだけ認証なし。
- 未認証リクエストは401。
- stage access log、X-Ray、method settings/throttling、WAF、cacheは未設定。

### Cognito

- Password policy: 8文字以上、英大文字・小文字・数字・記号必須、temporary password 7日。
- Prevent user existence errorsとtoken revocationは有効、email更新は再検証必須。
- App client secretは生成していない。
- MFA OFF、advanced security add-onなし、user pool deletion protection INACTIVE。
- `ALLOW_CUSTOM_AUTH` が有効だが、現行UIはUSER_SRP_AUTHを使う。不要ならauth flowを絞る。

### Lambda / IAM / Logs

- 業務Lambda 7個はNode.js 22、512 MiB、timeout 30秒、x86_64。
- X-RayはPassThrough、reserved concurrencyなし、DLQなし、環境変数KMS keyなし。
- CloudWatch Logsは保持期限なし、customer KMS keyなし。
- IAMのDynamoDB/S3/Lambda/AgentCore対象resourceは具体ARNに限定されている。一方、DynamoDB grantは `Scan` を含み、RuntimeのBedrock invokeはresource `*`。

### DynamoDB / S3

- 10テーブルすべてACTIVE、PAY_PER_REQUEST、PITR ENABLED。CloudFormationはRETAINだが、テーブル自体のdeletion protectionはfalse。
- DynamoDBはAWS所有keyによるデフォルト暗号化。customer-managed keyとresource policyはなし。
- avatar bucketはPublic Access Block全項目true、SSE-S3、HTTPを明示Deny。
- bucket versioning、server access loggingは未設定。CORSはorigin/header `*`、method POST。

### AgentCore / Amplify Hosting

- dev/main Runtime / GatewayはいずれもREADY。dev MemoryもACTIVE。
- RuntimeはPUBLIC network + Cognito custom JWT authorizer + required scope。Gatewayも同じJWT authorizer。
- Gateway REQUEST Interceptorはdev/mainで設定済みで、`passRequestHeaders=true`、Cognito access token再検証、JWT `sub` の内部注入を行う。SEC-01は実環境で解消した。
- Runtime allowlistにはAuthorizationとcustom authorizationがあり、Runtime Memoryの `actorId` 決定には署名未検証payloadを使用するため、SEC-03は引き続き成立する。
- Memoryは90日、preference / summary / semantic strategyがactorId namespaceで有効。
- devでは `ENABLE_AGENTCORE_RESOURCES=true`、`ENABLE_WEB_SEARCH_TOOL=true`、providerはTavily。したがってSEC-02の「falseでもhttp_requestがロード」は現在のdev設定では休眠しているが、外部検索結果のprompt injection対策は必要。
- `TAVILY_API_KEY` はAmplify app environment variableとRuntime environment variableに設定済み。値は監査出力へ表示していないが、Secrets Managerへ移行すべき。
- Amplify HostingはSPA rewriteあり、custom security headersなし、WAFなし、branch auto buildは有効。

## 8. 推奨対応順

1. Web取得ツールを一時停止し、SEC-02のflag判定とSSRF防御を実装。
2. custom authorizationを廃止し、Memory actorを検証済みclaimへ固定。
3. npm依存関係を更新し、全監査とビルド／E2Eを通す。
4. Secrets Manager移行、入力schema共通化、エラー応答標準化。
5. AWS stage/log/WAF/throttling、Cognito MFA、SPA security headersを環境別に設定。
6. CIへsecret scan、dependency audit、IaC scan、認可回帰テストを追加。

## 9. 実施した検証

- `npm run backend:typecheck`: 成功
- `npm run frontend:build`: 成功（chunk size警告あり）
- `npm ci`: lockfile同期後のclean install成功（Amplify内のAWS SDK peer dependency警告あり）
- `npm audit --omit=dev`: high 5 / moderate 4
- `npm audit`: critical 2 / high 33 / moderate 32 / low 4
- `pip-audit -r amplify/agentcore/runtime/requirements.txt`: 既知脆弱性0
- shell script構文確認: 成功
- Git差分whitespace確認: 最終修正後に再実施
- secret pattern scan（current + 全147 commits）: 候補0
- 未認証Core API: 401
- 未認証AgentCore Runtime: 401
