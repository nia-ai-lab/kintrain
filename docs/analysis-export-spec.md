# KinTrain 分析用データエクスポート仕様

最終更新日: 2026-07-26

## 1. 目的

保存済みの身体・体調・日記・運動・トレーニング情報と、現在のプロフィール・目標・メニュー構成を、外部AIが一貫して解釈できるJSON形式で取得できるようにする。

ブラウザーでは単一JSONファイルをダウンロードする。MCPでは同じスキーマ名とフィールド構造をmanifestとセクション別ページに分けて返す。

## 2. 対象範囲

- 期間指定: `from`、`to`のローカル日を両端含みで取得
- 全期間: 保存されている全Daily記録・GymVisitを取得
- 期間にかかわらず含む現在値:
  - ユーザープロフィール
  - 目標
  - トレーニングメニュー
  - トレーニングメニューセット
- 含めない情報:
  - Cognito ID、アクセストークンなどの認証情報
  - アバター画像、オブジェクトキー、署名付きURL
  - AIチャット履歴
  - 入力途中のトレーニング
  - AIキャラクター設定
  - セット別明細
  - GymVisitと重複するTrainingPerformance内部行

Goalは現在値を上書き保存するモデルであるため、過去の目標変更履歴は含まれない。

## 3. ブラウザー出力

- MIME type: `application/json;charset=utf-8`
- schema: `kintrain.analysis-export`
- schemaVersion: `2`
- ファイル名:
  - 期間指定: `kintrain-analysis_{from}_{to}_{timestamp}.json`
  - 全期間: `kintrain-analysis_all_{timestamp}.json`
- 履歴配列はローカル日昇順。同日は実施開始UTC時刻昇順。
- 未入力の単一値は`null`、配列は`[]`とする。

トップレベル構造:

```json
{
  "schema": "kintrain.analysis-export",
  "schemaVersion": 2,
  "generatedAtUtc": "2026-07-26T00:00:00.000Z",
  "selection": {
    "rangeMode": "dateRange",
    "fromLocalDate": "2026-01-01",
    "toLocalDate": "2026-07-26",
    "inclusive": true,
    "timeZoneId": "Asia/Tokyo"
  },
  "coverage": {
    "firstRecordDate": "2026-01-01",
    "lastRecordDate": "2026-07-26",
    "dailyRecordCount": 100,
    "gymVisitCount": 40
  },
  "currentContext": {
    "userProfile": {},
    "goal": {},
    "trainingMenus": [],
    "trainingMenuSets": []
  },
  "history": {
    "dailyRecords": [],
    "gymVisits": []
  }
}
```

## 4. Core APIページング

ブラウザーは次のAPIを`nextToken`がなくなるまで取得し、全ページ取得成功後にだけファイルを生成する。

- `GET /training-menu-items?limit&nextToken`
- `GET /daily-records?from&to&limit&nextToken`
- `GET /gym-visits?from&to&limit&nextToken`

全期間の場合、Daily/Gymの`from`と`to`は両方省略する。期間指定では両方必須とし、片方だけ、実在しない日付、`from > to`は400とする。

Core APIの`nextToken`は署名付きのversion 2形式とし、内部`userId`を格納しない。署名をユーザー、対象API、期間に関連付け、改ざん、別ユーザーまたは別期間への流用は400とする。version 1以前のトークンは受け付けない。

## 5. MCP

### 5.1 Manifest

`get_analysis_export_manifest`

- `rangeMode`: `dateRange` / `allAvailable`
- `from`, `to`: `dateRange`の場合に必須
- `timeZoneId`: 省略時`Asia/Tokyo`

プロフィール、現在の目標、スキーマ情報、取得対象セクション、ページング指示を返す。

### 5.2 Page

`get_analysis_export_page`

- `section`: `trainingMenus` / `trainingMenuSets` / `dailyRecords` / `gymVisits`
- `limit`: 1-50、既定50
- `nextToken`: 最初は省略し、続きでは直前の同一条件レスポンス値を指定

レスポンス:

```json
{
  "schema": "kintrain.analysis-export",
  "schemaVersion": 2,
  "selection": {},
  "section": "dailyRecords",
  "items": [],
  "page": {
    "limit": 50,
    "returned": 50,
    "nextToken": "opaque-token-or-null",
    "hasMore": true
  }
}
```

呼び出し側は必要な各セクションについて`page.nextToken`が`null`になるまで同一条件で呼び出す。トークンには内部`userId`を格納せず、署名をユーザー、スキーマバージョン、セクション、期間、タイムゾーンに関連付ける。改ざんまたは異なる条件への流用は拒否する。

## 6. 重量の意味

schemaVersion 2では、メニューと実施履歴に重量換算情報を含める。

- `weightKg`: ユーザーが入力した値
- `weightInputMode`: `direct` / `perSide` / `legacyUnspecified`
- `loadMultiplier`: 入力値に掛ける倍率。現在は1または2
- `fixedWeightKg`: バーなど、倍率適用後に加える固定重量
- `calculatedTotalWeightKg`: `weightKg * loadMultiplier + fixedWeightKg` の計算結果

GymVisit内では、後からメニュー設定が変わっても履歴の意味が変わらないよう、入力方式を実施時点のスナップショットとして保存する。旧履歴は推測せず`legacyUnspecified`とし、換算できない値は`null`にする。

## 7. 整合性

エクスポート中の更新をロックしないため、監査用の時点スナップショットではない。通常の分析用途を対象とし、取得途中でAPIエラーが発生した場合、ブラウザーは不完全なファイルを生成しない。
