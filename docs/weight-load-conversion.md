# 重量入力と換算総重量

## 保存方式

重量はメニューごとに次の設定を保持する。

- `weightInputMode`
  - `direct`: 入力値が総重量
  - `perSide`: 入力値が片側重量
  - `legacyUnspecified`: 旧データで重量の意味が未設定
- `loadMultiplier`: 1または2
- `fixedWeightKg`: バーなどの固定重量

換算総重量は次の式で求める。

`calculatedTotalWeightKg = weightKg * loadMultiplier + fixedWeightKg`

`weightKg`はユーザーが入力した値を保持し、換算値で上書きしない。

## 実施履歴

実施記録には、メニュー設定を次のフィールドへスナップショット保存する。

- `weightInputModeSnapshot`
- `loadMultiplierSnapshot`
- `fixedWeightKgSnapshot`
- `calculatedTotalWeightKg`

バックエンドは保存時に換算総重量を再計算する。過去のメニュー設定変更によって、保存済み履歴の意味は変化しない。

既存履歴は機器名などから推測せず、`legacyUnspecified`として扱う。
