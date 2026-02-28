# API UI仕様テストケース対応表

本ファイルは `docs/ui-spec.md` / `docs/spec.md` を根拠に、UIアクセスパターンをAPIテストへ落とした対応表。

## 根拠ドキュメント

- `docs/ui-spec.md`
- `docs/spec.md`（6. API要件）

## テストケース一覧

1. 未ログイン時API拒否（401）
- UI根拠: `ui-spec.md` 4, 14
- API: `GET /me/profile`（Authorizationなし）

2. ユーザ設定の読取/保存
- UI根拠: `ui-spec.md` 12
- API: `GET /me/profile`, `PUT /me/profile`

3. メニュー画面の追加/一覧/更新/並び替え/削除
- UI根拠: `ui-spec.md` 7
- API:
- `POST /training-menu-items`
- `GET /training-menu-items`
- `PUT /training-menu-items/{trainingMenuItemId}`
- `PUT /training-menu-items/reorder`
- `DELETE /training-menu-items/{trainingMenuItemId}`

4. 実施画面の初期表示データ取得
- UI根拠: `ui-spec.md` 6
- API: `GET /training-session-view?date=YYYY-MM-DD`

5. 実施画面の記録確定/履歴参照/更新/削除
- UI根拠: `ui-spec.md` 6, 10
- API:
- `POST /gym-visits`
- `GET /gym-visits?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /gym-visits/{visitId}`
- `PUT /gym-visits/{visitId}`
- `DELETE /gym-visits/{visitId}`

6. Daily画面の当日取得/更新/範囲取得
- UI根拠: `ui-spec.md` 10
- API:
- `GET /daily-records/{date}`
- `PUT /daily-records/{date}`
- `GET /daily-records?from=YYYY-MM-DD&to=YYYY-MM-DD`

7. カレンダー画面の月表示
- UI根拠: `ui-spec.md` 9
- API: `GET /calendar?month=YYYY-MM`

8. AIチャット表示用キャラクター設定
- UI根拠: `ui-spec.md` 11, 12
- API:
- `GET /ai-character-profile`
- `PUT /ai-character-profile`

9. 目標値管理
- UI根拠: `spec.md` 5.5, 6
- API:
- `GET /goals`
- `PUT /goals`
