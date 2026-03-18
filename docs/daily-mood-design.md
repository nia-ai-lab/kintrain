# Daily 気分追加・体調/気分 10段階化 設計書

最終更新日: 2026-03-18  
対象: Daily / Calendar / Dashboard / Core API / DynamoDB

## 1. 目的

`DailyRecord` に `気分` を追加し、既存の `体調` と分離して記録できるようにする。  
同時に、`体調` と `気分` の評価スケールを 5 段階から 10 段階へ拡張し、UI 上の入力方式を顔文字ではなくグラデーション付きスライダーへ変更する。

本変更は以下を狙う。

- 体の状態とメンタル状態を別々に記録できるようにする
- より細かい自己観察を可能にする
- カレンダー上で、日ごとの状態をモダンで一覧性の高い形で確認できるようにする

## 2. 要件の理解

今回の変更要件は次のとおり理解する。

1. `体調` は身体コンディションを表す既存評価項目として残す
2. `気分` は新規評価項目として `DailyRecord` に追加する
3. `体調` / `気分` はどちらも 10 段階評価（`1..10`）に統一する
4. `Daily` 画面の入力UIは、顔文字ボタンを廃止し、色の変化で良し悪しが分かるスライダーUIに置き換える
5. `Calendar` 画面では、各日付セルに `体調` と `気分` を上下2段の色で表示する
6. 既存の `体調コメント` 入力欄は残すが、意味としては `体調・気分の両方に関する自由記述欄` として扱う

## 3. 非対象

- 日記機能そのものの仕様変更
- `Goal` 機能の変更
- AI Runtime / MCP への今回時点での追加連携
- テクノロジー変更

## 4. 用語定義

- `ConditionRating`: 身体的な体調評価。値域は `1..10`
- `MoodRating`: 精神的な気分評価。値域は `1..10`
- `ConditionComment`: 既存コメント欄。今後は「体調・気分の両方に関するコメント」を表す
- `DailyMoodSlider`: `Daily` 画面上で `体調` / `気分` を入力するためのグラデーションスライダーUI
- `CalendarDailyStripe`: `Calendar` 画面で各日付セルに表示する、体調/気分を色で示す上下2本のバー

## 5. 仕様変更概要

### 5.1 DailyRecord モデル

現行:

- `conditionRating?: 1..5`
- `conditionComment?: string`

変更後:

- `conditionRating?: 1..10`
- `moodRating?: 1..10`
- `conditionComment?: string`

補足:

- `conditionComment` はフィールド名を変更しない
- ただし意味は「体調・気分の両方についての自由記述」に変更する

### 5.2 UI 表現

現行:

- 顔文字5個のワンタップ選択UI

変更後:

- `体調` と `気分` の2セクションを表示
- 各セクションは `1..10` のスライダー
- スライダーのつまみ位置と背景グラデーションにより状態を表現
- ラベルの意味は数値で扱い、顔文字は使用しない

### 5.3 カレンダー表現

現行:

- 日付セル内に `体調` 5段階の顔文字または未入力記号

変更後:

- 日付セル下部に `上下2本` の色バーを表示
- 上段: `体調`
- 下段: `気分`
- 未入力時は淡色またはプレースホルダ表示
- 顔文字は使わない

## 6. UI設計

### 6.1 Daily 画面

#### 6.1.1 セクション構成

- `体重・体脂肪率`
- `体調`
- `気分`
- `コメント`
- `日記`
- `その他トレーニング`
- `当日の筋トレ内容`

現行の `体調` セクションを以下へ分割する。

- `体調`
- `気分`

コメント欄はどちらかの中に内包せず、共通コメント欄として残す。

#### 6.1.2 スライダーUI

各評価セクションの表示要素:

- タイトル: `体調` または `気分`
- 補助表示:
  - 左端: `低い`
  - 右端: `高い`
  - 現在値: `n / 10`
- スライダー:
  - 値域 `1..10`
  - 1刻み
  - 連続ドラッグ可能
  - つまみ移動時に色も連動

グラデーション方針:

- 低評価: コーラル/レッド系
- 中間: アンバー/イエロー系
- 高評価: ティール/グリーン系

例:

- `1`: #c7665c
- `5`: #dba95f
- `10`: #0f766e

UI上の見せ方:

- スライダーのトラックにグラデーション背景を持たせる
- 現在位置までを高彩度、以降を低彩度にする
- 数値ラベルを併記して、色覚差異があっても意味が取れるようにする

#### 6.1.3 コメント欄

- ラベルは現状の `コメント` を維持してよい
- プレースホルダ文言は次のように変更する
  - `体調や気分のメモ`

意味:

- 身体面と気分面の両方について自由に記入する欄

### 6.2 カレンダー画面

#### 6.2.1 日付セル構成

各セルの構成:

- 上部: 日付
- 中央: 筋トレ実施有無ドット
- 下部: `CalendarDailyStripe`

`CalendarDailyStripe` 表示:

- 上段バー: `体調`
- 下段バー: `気分`
- 各バーは評価値 `1..10` を色へ変換して表示

表示例:

- 両方記録あり: 2本とも色つき
- 片方のみ記録あり: 該当バーのみ色つき、もう片方は淡いグレー
- 両方未記録: 2本とも淡いグレー

#### 6.2.2 色変換ルール

数値 `1..10` を HSL ベースでマッピングする。

推奨:

- hue: `8 -> 170`
- saturation: 固定 55〜65%
- lightness: 60〜72%

これにより

- 低い値 = 赤寄り
- 高い値 = 緑/ティール寄り

を自然に表現できる。

### 6.3 ダッシュボード

`今日の状態` サマリーを以下に変更する。

- 体重
- 体脂肪率
- 体調 (`n/10`)
- 気分 (`n/10`)

モバイル幅に応じて4項目を2段表示またはスクロールなしで収まる密度に調整する。

## 7. データモデル変更

### 7.1 Frontend 型

変更対象:

- `frontend/src/types.ts`

変更内容:

- `ConditionRating` を `1 | 2 | ... | 10` に変更
- 新規 `MoodRating` 型を追加、または `ConditionRating` を再利用
- `DailyRecord` に `moodRating?: 1..10` を追加

推奨:

- `ConditionRating` を `1..10` に拡張
- `MoodRating = ConditionRating` の型エイリアスを使ってもよい

### 7.2 Backend DTO

変更対象:

- `GET /daily-records/{date}`
- `PUT /daily-records/{date}`
- `GET /calendar?month=YYYY-MM`

追加・変更内容:

- `DailyRecord` に `moodRating`
- `CalendarMonth.days[]` に `moodRating`
- `conditionRating` は `1..10` に変更

## 8. API設計変更

### 8.1 `GET /daily-records/{date}`

レスポンスへ追加:

- `moodRating?: number`

### 8.2 `PUT /daily-records/{date}`

受信可能項目へ追加:

- `moodRating?: number`

バリデーション:

- `conditionRating`: `1..10`
- `moodRating`: `1..10`

### 8.3 `GET /calendar?month=YYYY-MM`

各日付レスポンスを以下へ拡張:

- `date`
- `trained`
- `conditionRating?: number | null`
- `moodRating?: number | null`

## 9. DynamoDB 設計変更

対象:

- `DailyRecordTable`

追加属性:

- `moodRating` (Number)

既存属性変更:

- `conditionRating` の意味を `1..5` から `1..10` へ拡張

主キー変更:

- なし

GSI変更:

- なし

Scan:

- 追加しない

## 10. 既存データ移行方針

既存データに対する移行は、アプリケーションコードでは考慮しない。

方針:

- Runtime / API / UI / AppState / DynamoDB handler に、旧 `1..5` データかどうかを判定する分岐は入れない
- 読み込み時の自動正規化ロジックは実装しない
- 既存データ移行が必要な場合は、別途バッチまたは手動移行作業で対応する
- 本設計の実装対象は、新仕様 `conditionRating: 1..10` / `moodRating: 1..10` を前提とする

補足:

- `moodRating` は新規追加項目であり、既存データには存在しない
- 既存テーブルの値整合はアプリ本体ではなく、運用移行タスクとして扱う

## 11. コンポーネント設計

### 11.1 新規コンポーネント

推奨新規:

- `DailyGradientSlider`

責務:

- `value: 1..10 | undefined`
- `label`
- `onChange`
- グラデーション計算
- 数値表示

再利用先:

- `DailyPage`
- 将来 `Dashboard` の簡易入力導線にも転用可能

### 11.2 Calendar セル表示

既存セルに対し、顔文字表示部分を廃止し、`calendar-mood-bars` 相当のUIを追加する。

## 12. 変更対象ファイル（想定）

フロント:

- `frontend/src/types.ts`
- `frontend/src/pages/DailyPage.tsx`
- `frontend/src/pages/CalendarPage.tsx`
- `frontend/src/pages/DashboardPage.tsx`
- `frontend/src/styles/app.css`
- `frontend/src/components/DailyRatingSlider.tsx`

バック:

- `frontend/src/api/coreApi.ts`
- `frontend/src/AppState.tsx`
- `amplify/functions/daily-record-api/handler.ts`

設計書更新:

- `docs/spec.md`
- `docs/ui-spec.md`

## 13. タスクリスト

1. `DailyRecord` / Calendar DTO に `moodRating` を追加
2. `conditionRating` の許容範囲を `1..10` へ変更
3. Daily API の GET/PUT を更新
4. Calendar API の月次レスポンスへ `moodRating` を追加
5. フロント型更新
6. `DailyRatingSlider` を追加し、旧5段階入力UIを置換
7. Daily 画面へ `体調` / `気分` スライダーを追加
8. コメント欄の意味と文言を調整
9. カレンダーのセル表示を上下2色バーに変更
10. ダッシュボード `今日の状態` へ `気分` を追加
11. `docs/spec.md` / `docs/ui-spec.md` 更新

## 14. 受け入れ基準

1. Daily 画面で `体調` と `気分` を別々に 10 段階で入力できる
2. 入力UIは顔文字ではなく色付きスライダーである
3. `体調コメント` 欄は残り、体調・気分の両方のメモとして利用できる
4. カレンダー各日付セルに `体調` / `気分` が上下2色で表示される
5. 実装コードに旧データ互換のための分岐が含まれていない
6. API / DynamoDB のキー設計に変更がない
