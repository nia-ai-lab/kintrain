# MCP一時メニュー・ライフサイクル仕様

## 1. 正本と対象

本書は、MCPから一時トレーニングメニューを取得、更新、日程変更、キャンセルする際の正本とする。

公開ツール:

- `get_training_plan_for_date`
- `reschedule_temporary_training_plan`
- `update_temporary_training_menu_set`
- `cancel_temporary_training_plan`

## 2. バージョンと監査

- `TrainingMenuSet.version`は非負整数とする。
- 新規セットは`version=1`で作成する。
- 旧レコードで`version`がない場合は`version=0`として扱い、最初の更新で`1`へ移行する。
- 更新系ツールは`expectedVersion`を必須とし、不一致時は書き込まず`VERSION_CONFLICT`を返す。
- 成功時は`version`を1増加させ、`updatedAt`、`updatedBy`、`updateReason`を保存する。
- 更新主体は認証済み実行経路からサーバー側で決定し、モデル入力を信用しない。

## 3. 冪等性

- 更新系ツールは`idempotencyKey`を必須とする。
- セットへ直近のキー、要求ハッシュ、差分を保存する。
- 同じキーと同じ要求の再実行は書き込まず、`idempotentReplay=true`で成功結果を返す。
- 同じキーを異なる要求へ再利用した場合は`IDEMPOTENCY_KEY_REUSED`を返す。

## 4. 指定日取得

`get_training_plan_for_date(date, timeZoneId?)`は`DailyTrainingPlan`を割り当ての正本として参照する。

- 未割り当てまたは無効セットの場合は`plan=null`を返す。
- `planType=rest` は計画された完全休息日として返し、種目・処方は返さない。
- セットID、名前、種別、有効期間、バージョン、種目マスタ情報、セット項目ID、表示順、処方を返す。
- `date`は明示されたローカル日付であり、タイムゾーン変換で別の日付へ移動させない。

## 5. 日程変更

`reschedule_temporary_training_plan`はセットID、セット項目、種目マスタ、処方を変更しない。

- 最大有効期間は開始日を含め31日。
- `restDates` は新しい有効期間内の日付だけを指定できる。省略時は新期間にも含まれる既存休息日を保持する。
- `dryRun=true`では書き込みを行わず、日付差分と不変項目を返す。
- `conflictPolicy=reject`を既定とする。
- `conflictPolicy=replace`はユーザーの明示確認を必須とする。
- 置換対象セットに新期間外の割り当てが残る場合、部分置換を拒否する。
- 安全に全置換できる競合セットは、同一トランザクション内で論理キャンセルする。

## 6. 一般更新

- 未指定のセット名・処方は保持する。
- `itemUpdates`は既存`trainingMenuSetItemId`を更新する。
- `itemAdds`は既存かつ有効な`trainingMenuItemId`を参照するか、`newTrainingMenuItem`を指定する。
- `newTrainingMenuItem`を指定した場合、種目マスタ作成とセット項目追加を同一トランザクションで実行し、セット更新だけ、または種目マスタ作成だけが残る部分成功を許可しない。
- `itemRemovals`はセット項目IDを明示する。
- `itemOrder`は更新後に残る既存セット項目IDを全件、重複なく指定する。
- 更新後のセットは1〜12件の一意な種目で構成する。
- 日付変更と内容変更は1回の要求へ混在させず、日付変更専用ツールを先に使用する。
- 内容変更は最初に`dryRun=true`で差分を取得し、ユーザーへ提示する。
- 確定時はユーザーの明示承認を得て`userConfirmed=true`を指定する。通常の内容変更でも承認なしの書き込みを拒否する。

## 7. キャンセル

- キャンセルは物理削除ではなく`isActive=false`とする。
- `canceledAt`、`canceledBy`、`cancelReason`を保存する。
- キャンセル時点のセット名、種目名、セット項目ID、種目ID、処方を`cancellationSnapshot`として保存する。
- 関連する`DailyTrainingPlan`を同一トランザクションで解除する。
- セット、セット項目、種目ID、処方は保持する。
- 確定には`userConfirmed=true`を必須とする。dry-runは確認前でも利用できる。

## 8. エラーコード

- `NOT_FOUND`
- `VERSION_CONFLICT`
- `DATE_CONFLICT`
- `VALIDATION_ERROR`
- `IDEMPOTENCY_KEY_REUSED`
- `PLAN_ALREADY_CANCELED`
- `USER_CONFIRMATION_REQUIRED`
