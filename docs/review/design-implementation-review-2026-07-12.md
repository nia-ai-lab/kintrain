# 設計・実装整合性レビュー

実施日: 2026-07-12
判定基準: コードを現行仕様の正とする。ただし、コードにセキュリティ欠陥がある場合は、危険な挙動を目標設計として追認せず「現状」と「是正後の要件」を併記する。

## 結論

設計書には、2026年3月以降に実装されたAgentCore、AIメニュー生成、メニューセット、TrainingPerformance、アバター保存が十分反映されていなかった。主要な不一致は今回更新した。ビルド・デプロイ手順はREADME内に分散し、初期構築手順と現行運用が混在していたため、`docs/deployment.md` を運用正本として追加した。

## 修正した主な不一致

| 項目 | 修正前の文書 | 現行コード | 対応 |
|---|---|---|---|
| AgentCore | Runtime/Gateway/Memoryは未実装またはGateway未実装 | `backend.ts` で条件付き作成、Runtime・Gateway・Memory・MCP Lambdaを実装 | README、要件、AI実装仕様を更新 |
| AIチャット | モックストリーミング | Runtime設定時はSSE、未設定時だけ通常チャットがモックへフォールバック | README、UI設計を更新 |
| AI設定 | UIローカル反映のみ | `GET/PUT /ai-character-profile` へ永続保存 | README、要件、UI設計を更新 |
| アバター | default固定 | private S3へのpresigned POST、signed GET、削除、UIトリミング／圧縮 | README、要件、UI設計を更新 |
| AIメニュー生成 | 実装前／未着手／プレビュー型モック | 専用チャット、MCP transaction登録、最大20種目、重複拒否 | 仕様・設計・タスクリスト・UI設計を更新 |
| メニューセット | Core API一覧やデータ設計に不足 | set / set-itemテーブル、API、GSI、実施画面で切替 | 要件のAPI・データ構成を更新 |
| デプロイ | 初期手順とローカル手動方式が混在 | GitHubのmain/devへのpushを契機にAmplifyが自動デプロイ | `docs/deployment.md` をpush方式に限定し、READMEから手動方式を削除 |
| DynamoDB物理名 | `tableName` 未指定との記述 | `KinTrain-{モデル}-{branch}` を明示指定 | READMEを修正 |
| 依存関係導入 | `npm install`、かつroot lockfileにfrontendの `react-easy-crop` が欠落 | clean install可能なlockfileとCI再現性が必要 | lockfileをmanifestへ同期し、Amplify buildを `npm ci` に変更 |

## セキュリティ要件との意図的な差分記録

レビュー時点で次の2点は、危険なコードを正しい設計として文書化せず、安全な目標要件を維持した。

1. MCP tool schemaが `userId` をモデル入力として公開し、Lambdaが `args.userId` を優先していた。Gateway REQUEST InterceptorによるJWT検証・不一致拒否・内部identity注入へ修正し、dev/mainへ反映した。現行の正本は `docs/mcp-security-design.md` とする。
2. `ENABLE_WEB_SEARCH_TOOL=false` でも、providerが既定の `http_request` ならHTTP取得ツールがロードされる。設定名が示す契約を正とし、無効時はロードしない要件を明記した。

詳細と優先度は `docs/review/security-review-2026-07-12.md` を参照する。

## 現在の文書正本

- 全体要件: `docs/spec.md`
- UI: `docs/ui-spec.md`
- AI経路: `docs/ai-implementation-spec.md`
- AIメニュー生成: `docs/ai-menu-generation-spec.md` / `docs/ai-menu-generation-design.md`
- メニューセットDB/API: `docs/training-menu-and-daily-plan-requirements.md`
- TrainingPerformance: `docs/training-performance-design.md`
- ビルド／デプロイ: `docs/deployment.md`
- MCPユーザー境界: `docs/mcp-security-design.md`
- 構成図: `docs/kintrain-architecture.svg`

## 残課題

- 日付形式は正規表現だけで検証し、存在しない日付を一部受理する。
- Core APIの一部自由記述に長さ上限がなく、目標値の業務範囲チェックも不足する。
- `training-menu-api` とMCP Lambdaの入力検証が重複し、重量0の扱いなどに差がある。
- `/history` と `/progress` はプレースホルダのまま。
- 実装後に正本ではなくなった旧メニューセット設計は、現行要件への統合後に削除した。
