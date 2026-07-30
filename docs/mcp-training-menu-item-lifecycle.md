# MCP種目マスター・ライフサイクル仕様

## 1. 対象ツール

- `list_training_menu_items`
- `update_training_menu_item`
- `archive_training_menu_item`

未登録の一時メニュー案はMCP上のデータではない。ChatGPTやClaudeは会話内で案を修正し、ユーザーが最新案の登録を明示した場合だけ`create_temporary_training_menu_set_from_ai`を呼ぶ。

## 2. 一覧・検索

`list_training_menu_items`は従来の引数なし呼び出しを維持し、任意で`query`、`includeInactive`、`onlyAiGenerated`、`limit`、`nextToken`を受け付ける。

- 既定では有効な種目だけを返す。
- `query`は種目名と説明を空白・英字大小を正規化して部分一致検索する。
- レスポンスは`version`、`updatedAt`、`updatedBy`、`updateReason`を含む。
- 影響確認用に利用中セットID・件数、割り当て日・件数、将来割り当て有無を返す。
- `nextToken`は認証済みユーザーと検索条件へ署名付きで関連付け、別条件・別ユーザーへの流用を拒否する。

## 3. バージョンと監査

- `TrainingMenuItem.version`は非負整数とする。
- 新規作成は`version=1`とする。
- 旧レコードで`version`がない場合は`version=0`として扱う。
- 更新・アーカイブは`expectedVersion`を必須とし、不一致時は書き込まず`VERSION_CONFLICT`を返す。
- 成功時は`version`を1増加させ、`updatedAt`、`updatedBy`、`updateReason`を保存する。
- MCP更新は`idempotencyKey`、要求ハッシュ、直近差分を保存し、同一要求を安全に再実行できるようにする。

## 4. 更新

- `update_training_menu_item`は未指定フィールドを保持する部分更新とする。
- 更新可能項目は名称、種目ファミリー、筋肉分類、動作分類、左右性、負荷モデル、器具、器具設定、説明、重量入力方式、固定重量とする。
- 最初に`dryRun=true`を呼び出し、変更前後と影響する有効セット・割り当て日を返す。
- 確定には`userConfirmed=true`を必須とする。
- 名称重複、入力不正、版競合では書き込まない。
- 過去の実施履歴は保存時点のスナップショットを保持し、種目マスター更新で書き換えない。

## 5. アーカイブ

- `archive_training_menu_item`は物理削除せず`isActive=false`とする。
- 最初に`dryRun=true`で影響範囲を返し、確定には`userConfirmed=true`を必須とする。
- `archivedAt`、`archivedBy`、`archiveReason`を保存する。
- セットとの関連および過去の実施履歴は削除しない。
- アーカイブ後の種目は新しい一時メニューへ追加できず、実施画面の有効種目から除外される。

## 6. エラーコード

- `NOT_FOUND`
- `VERSION_CONFLICT`
- `VALIDATION_ERROR`
- `IDEMPOTENCY_KEY_REUSED`
- `USER_CONFIRMATION_REQUIRED`
- `ITEM_ALREADY_ARCHIVED`
