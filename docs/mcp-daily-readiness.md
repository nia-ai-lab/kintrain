# MCP Daily回復状態・保存仕様

## 1. 対象

`save_daily_readiness`は、Dailyの回復・トレーニング準備に関する項目をMCPから部分更新する。

対象項目:

- `sleepHours`
- `sleepQuality`
- `fatigueLevel`
- `motivationLevel`
- `muscleSorenessLevel`
- `restingHeartRate`
- `painAreas`

日記、食事メモ、体組成、その他トレーニングなど、指定されていないDaily項目は保持する。

## 2. 睡眠時間の登録

睡眠時間は次のいずれかで登録する。

1. `sleepHours`を0〜24の数値で直接指定する。
2. `sleepStartedAtLocal`と`wokeUpAtLocal`を`YYYY-MM-DDTHH:mm`形式で対にして指定する。

就寝・起床日時を指定した場合、Lambdaが`timeZoneId`を使って経過時間を計算し、100分の1時間に丸めて`DailyRecord.sleepHours`へ保存する。モデルが計算した値は使用しない。

- 睡眠区間は0時間より長く24時間以下とする。
- 存在しないローカル日時、終了が開始以前となる区間は拒否する。
- `date`は起床日のローカル日付とする。
- `date`省略時は`wokeUpAtLocal`の日付を使用する。
- `sleepHours`と就寝・起床日時の同時指定は拒否する。

## 3. 保存先の振り分け

- 食事、飲み物、水分、栄養、サプリメントは`save_daily_meal_notes`へ保存する。
- 出来事、感想、気づきは`save_daily_diary`へ保存する。
- 睡眠、疲労、やる気、筋肉痛、安静時心拍数、痛みは`save_daily_readiness`へ保存する。

食事内容を日記へ保存してはならない。ツール説明とAgentCore Runtimeのシステムプロンプトの両方へ同じ振り分け規則を記載する。

## 4. 監査ログ

MCP Lambdaは、呼び出しごとに次のメタデータを構造化ログとして記録する。

- ツール名
- 引数名の一覧
- LambdaリクエストID

ユーザーID、日記本文、食事内容、健康状態の値はログへ記録しない。

## 5. 受け入れ基準

- `2026-07-28T23:30`就寝、`2026-07-29T07:00`起床、`Asia/Tokyo`で7.5時間になる。
- 算出結果が2026-07-29のDailyへ保存される。
- 就寝・起床の片方だけの入力を拒否する。
- 睡眠時間と就寝・起床日時の同時指定を拒否する。
- 食事の保存先として`save_daily_meal_notes`を明示し、日記ツールから除外する。
- 更新時に日記、食事メモ、その他トレーニングを保持する。
- 監査ログに入力値とユーザーIDを含めない。
