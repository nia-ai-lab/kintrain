# Training Menu Set バックエンド設計

最終更新日: 2026-03-01  
対象ブランチ: `dev`

## 1. 目的

- トレーニングメニューを「単一一覧」から「複数メニューセット」へ拡張する。
- デフォルトメニューセットを1つ定義し、実施画面はデフォルトセット配下の種目を表示する。
- 既存APIロジックに移行専用処理は含めない。
- 既存 `TrainingMenuTable` の PK/SK (`userId`, `trainingMenuItemId`) は変更しない。

## 2. テーブル設計

### 2.1 既存テーブル（変更なし）

- `TrainingMenuTable`
  - PK: `userId` (S)
  - SK: `trainingMenuItemId` (S)
  - GSI: `UserDisplayOrderIndex` (`userId`, `displayOrder`)
  - GSI: `UserTrainingNameIndex` (`userId`, `normalizedTrainingName`)

### 2.2 新規テーブル: `TrainingMenuSetTable`

- 用途: メニューセット本体管理
- PK: `userId` (S)
- SK: `trainingMenuSetId` (S)
- 属性:
  - `setName` (S)
  - `menuSetOrder` (N)
  - `isDefault` (BOOL)
  - `isActive` (BOOL)
  - `defaultSetMarker` (S, デフォルトセットのみ `"DEFAULT"` を保持)
  - `createdAt` (S, RFC3339 UTC)
  - `updatedAt` (S, RFC3339 UTC)
- GSI:
  - `UserMenuSetByOrderIndex`
    - PK: `userId`
    - SK: `menuSetOrder`
  - `UserDefaultMenuSetIndex`
    - PK: `userId`
    - SK: `defaultSetMarker`
    - 疎インデックス（デフォルトセットのみ）

### 2.3 新規テーブル: `TrainingMenuSetItemTable`

- 用途: セットと種目の紐付け（多対多）
- PK: `userId` (S)
- SK: `trainingMenuSetItemId` (S)
- 属性:
  - `trainingMenuSetId` (S)
  - `trainingMenuItemId` (S)
  - `displayOrder` (N)
  - `menuSetOrderKey` (S) = `${trainingMenuSetId}#${zeroPad(displayOrder, 6)}`
  - `menuSetItemKey` (S) = `${trainingMenuSetId}#${trainingMenuItemId}`
  - `createdAt` (S, RFC3339 UTC)
  - `updatedAt` (S, RFC3339 UTC)
- GSI:
  - `UserSetItemsBySetOrderIndex`
    - PK: `userId`
    - SK: `menuSetOrderKey`
    - `begins_with` でセット内順序一覧を取得
  - `UserSetItemsBySetAndItemIndex`
    - PK: `userId`
    - SK: `menuSetItemKey`
    - セット内重複判定・削除対象特定に利用
  - `UserSetItemsByMenuItemIndex`
    - PK: `userId`
    - SK: `trainingMenuItemId`
    - 種目削除時に、全セット紐付けをQueryで取得するために利用

## 3. アクセスパターン（Scan禁止）

### 3.1 メニューセット一覧取得

- Query `TrainingMenuSetTable.UserMenuSetByOrderIndex`
  - `userId = :userId`
  - 昇順取得

### 3.2 デフォルトセット取得

- Query `TrainingMenuSetTable.UserDefaultMenuSetIndex`
  - `userId = :userId AND defaultSetMarker = "DEFAULT"`
  - `Limit = 1`

### 3.3 セット作成

- Query `UserMenuSetByOrderIndex` 逆順 `Limit=1` で最大 `menuSetOrder` を取得
- Put `TrainingMenuSetTable`

### 3.4 セット更新（名前/デフォルト）

- 名前更新: Update `TrainingMenuSetTable`
- デフォルト切替:
  - 現デフォルト取得 (`UserDefaultMenuSetIndex`)
  - `TransactWrite` で旧デフォルト解除 + 新デフォルト設定を同時実行

### 3.5 セット内種目一覧

- Query `TrainingMenuSetItemTable.UserSetItemsBySetOrderIndex`
  - `userId = :userId`
  - `begins_with(menuSetOrderKey, :setPrefix)`
- 取得した `trainingMenuItemId` で `TrainingMenuTable` を `BatchGet`

### 3.6 セットへ種目追加

- Query `UserSetItemsBySetAndItemIndex` で重複チェック
- Query `UserSetItemsBySetOrderIndex` 逆順 `Limit=1` で最大順序取得
- Put `TrainingMenuSetItemTable`

### 3.7 セットから種目削除

- Query `UserSetItemsBySetAndItemIndex` で対象1件特定
- PK/SK で Delete

### 3.8 セット内並び替え

- 対象行の `displayOrder`, `menuSetOrderKey`, `updatedAt` を `TransactWrite` で更新

### 3.9 種目本体削除時の紐付け掃除

- Query `TrainingMenuSetItemTable.UserSetItemsByMenuItemIndex`
  - `userId = :userId AND trainingMenuItemId = :trainingMenuItemId`
- 取得した紐付け行を `TransactWrite` / `Delete` で削除

## 4. API設計

### 4.1 既存API（維持）

- `/training-menu-items` 系は維持

### 4.2 新規API

- `GET /training-menu-sets`
  - セット一覧 + 各セット配下 `itemIds`（順序付き）を返却
- `POST /training-menu-sets`
  - セット作成
- `PUT /training-menu-sets/{trainingMenuSetId}`
  - セット名更新 / デフォルト切替
- `POST /training-menu-sets/{trainingMenuSetId}/items`
  - セットへ種目追加
- `DELETE /training-menu-sets/{trainingMenuSetId}/items/{trainingMenuItemId}`
  - セットから種目削除
- `PUT /training-menu-sets/{trainingMenuSetId}/items/reorder`
  - セット内並び替え

## 5. 整合性ルール

- 1ユーザーにつき `isDefault=true` のセットは最大1件。
- すべてのQuery/Update/Deleteで `userId` を必須キー条件にする。
- `TrainingMenuSetItemTable` で同一セット内同一種目重複を禁止。
- `training-menu-item` 削除時は関連するセット紐付けも削除する。

## 6. 移行方針（APIに埋め込まない）

- 本番API/通常ロジックに移行用分岐は入れない。
- 移行は別バッチスクリプトとして実行する。

### 6.1 移行バッチの仕様

- 入力:
  - `userId`（必須）
  - `setName`（任意、デフォルト: `メインメニュー`）
- 処理:
  1. 対象ユーザーのセット件数を Query
  2. 0件ならセットを1件作成（`isDefault=true`）
  3. `TrainingMenuTable.UserDisplayOrderIndex` から種目一覧を Query
  4. 種目を順序どおり `TrainingMenuSetItemTable` に Put
- 特徴:
  - `Scan` 不使用
  - 対象ユーザー限定の安全実行

### 6.2 実装スクリプト

- ファイル: `scripts/migrate-training-menu-sets.mjs`
- 実行例:

```bash
TRAINING_MENU_TABLE_NAME=<table> \
TRAINING_MENU_SET_TABLE_NAME=<table> \
TRAINING_MENU_SET_ITEM_TABLE_NAME=<table> \
npm run migrate:menu-sets -- --user-id <cognito-sub> --set-name メインメニュー
```

- ドライラン:

```bash
npm run migrate:menu-sets -- --user-id <cognito-sub> --dry-run
```

## 7. 実装メモ

- 既存 `training-menu-api` Lambda にセット管理APIを追加する。
- API Gateway リソースも同Lambdaにルーティング追加する。
- フロントは `coreApi.ts` にセットAPIクライアントを追加する。
- 実施画面はデフォルトセットを基準に表示する。
