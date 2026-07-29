# KinTrain AIメニュー生成 タスクリスト

最終更新日: 2026-07-29
ステータス: 現行機能は実装完了

## 完了

- 条件フォーム、専用チャット、通常チャットとのセッション分離
- 有効開始日・終了日と31日上限のUI検証
- AgentCore RuntimeへのSSE接続と進行状態表示
- `list_training_menu_items` による既存種目参照
- 既存種目と新規種目を混在できる一時セット登録
- `create_temporary_training_menu_set_from_ai` のGateway schemaとMCP Lambda実装
- 1セット最大12種目
- `TrainingMenuItem` / `TrainingMenuSet` / `TrainingMenuSetItem` / `DailyTrainingPlan` の整合登録
- 冪等性キー、日付競合検出、ユーザー確認後の置き換え
- 登録後の `refreshCoreData()`
- 一時メニューの取得、日程変更、部分更新、論理キャンセル
- Gateway REQUEST Interceptorによるアクセストークン再検証と本人ID強制
- MCPツール境界、日付競合、ライフサイクルの回帰テスト

## 継続課題

- RuntimeのMemory `actorId` をRuntime認可済みclaimへ固定する
- Web取得を無効化設定どおりに停止し、loopback、link-local、private IP、
  AWS metadata/credential endpointを拒否する
- Webコンテンツを非信頼データとして扱うprompt injection対策を強化する
- 外部検索APIキーをRuntime環境変数からSecrets Manager参照へ移行する
- UI条件入力から実際のRuntime／Gateway登録までを含む自動E2Eを拡充する

セキュリティ課題の詳細は `docs/review/security-review-2026-07-12.md` を参照する。
