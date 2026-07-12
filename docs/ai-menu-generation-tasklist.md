# KinTrain AIメニュー生成 タスクリスト

最終更新日: 2026-07-12
ステータス: 実装完了（セキュリティ是正を除く）

## 完了

- 条件フォーム、専用チャット、セッション分離、追加指示、登録導線
- 通常AIチャットと共通のAgentCore Runtime接続
- `create_training_menu_set_from_ai` tool schema、Gateway公開、MCP Lambda実装
- 新規セット・新規種目・紐付けの単一DynamoDB transaction
- `isAiGenerated=true` 強制、最大20種目、名前重複拒否
- 登録後の `refreshCoreData()`
- 仕様書、実装設計、UI設計、README更新

## 残タスク

- MCP `userId` をモデル公開引数から削除し、検証済みidentityだけをLambdaへ渡す
- `ENABLE_WEB_SEARCH_TOOL=false` でHTTP取得ツールを確実に無効化する
- HTTP取得先のloopback、link-local、private IP、AWS metadata/credential endpointを拒否する
- Webコンテンツを非信頼データとして扱い、内容を理由に書き込みツールを実行しない制御を追加する
- UI条件入力から登録までの自動E2E、重複・ロールバック・ユーザー境界テストを追加する
