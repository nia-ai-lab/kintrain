# MCP 体重・体脂肪率 一括登録機能 要件定義

最終更新日: 2026-07-23
対象: AgentCore Runtime / MCP Gateway / MCP Lambda target / DailyRecord
ステータス: 要件確定

## 1. 目的

チャットやMCPクライアントから、複数日分の体重・体脂肪率を1回のMCPツール呼び出しで登録できるようにする。

主な利用例:

- ユーザーが過去1か月分の測定結果を表形式で提示し、まとめて登録する
- CSVなどから読み取った測定結果をAIが構造化し、まとめて登録する
- 既存記録との衝突を事前確認してから、安全に登録する

## 2. 現行仕様

- 体組成は独立したデータではなく、日付単位の `DailyRecord` に保持する。
- `DailyRecord` の主キーは `userId`、ソートキーは `recordDate` (`YYYY-MM-DD`) である。
- 現行MCPツール `save_body_metrics` は、1回の呼び出しで1日分を登録する。
- 現行 `save_body_metrics` は次をすべて必須とする。
  - `bodyWeightKg`
  - `bodyFatPercent`
  - `date`
  - `bodyMetricMeasuredTimeLocal`
- 保存時は、同日の `diary`、体調、気分、その他トレーニングなど、体組成以外の既存項目を保持する。
- Gateway REQUEST InterceptorがCognitoアクセストークンを検証し、JWT `sub` を内部の `userId` として強制する。

## 3. スコープ

### 3.1 対象

- 複数日分の体重・体脂肪率を受け取る新規MCPツール
- 入力全体の検証
- 同一リクエスト内の日付重複検出
- 既存 `DailyRecord` との衝突検出
- 既存の体組成以外のDaily項目を保持した登録
- 登録前の検証・差分確認
- 登録結果を日付単位で判別できる応答
- ユーザー境界、監査ログ、エラー処理

### 3.2 対象外

- KinTrain画面へのCSVアップロードUI追加
- MCP Lambda内でのCSV、Excel、画像、自然文の解析
- 体組成記録の削除
- 1日に複数回測定した履歴の保持
- 体重・体脂肪率以外のDaily項目の一括更新
- 既存 `save_body_metrics` の廃止
- 目標体重・目標体脂肪率の更新

補足:

- CSV、画像、自然文などの入力は、AIまたはMCPクライアントが構造化された `records[]` に変換してから本ツールを呼び出す。
- 現行データモデルは1日につき体組成1件であるため、同じ日の複数測定値を渡す用途には対応しない。

## 4. 用語

- `BodyMetricInput`: 一括登録する1日分の体組成入力。
- `conflictPolicy`: 指定日に既存の体組成がある場合の処理方針。
- `dryRun`: DynamoDBを更新せず、入力検証と登録予定結果だけを返す実行。
- `created`: 対象日の `DailyRecord` または体組成が新規に作成される状態。
- `updated`: 既存の体組成値が変更される状態。
- `unchanged`: 既存値と入力値が同一で、書き換えを必要としない状態。
- `conflict`: 既存値と入力値が異なり、指定された衝突方針では更新できない状態。
- `partially_succeeded`: 同一リクエスト内に成功レコードと失敗レコードが混在する実行結果。

## 5. 利用者要求

1. ユーザーは、複数日分の測定値を一度の依頼で登録できること。
2. ユーザーは、実際に更新する前に登録予定件数と衝突日を確認できること。
3. ユーザーが明示的に許可しない限り、既存の異なる体組成値を上書きしないこと。
4. 入力の一部に誤りがある場合、どの行のどの項目が不正か分かること。
5. 一部のレコードに入力不正、既存値との衝突、書き込み失敗があっても、処理可能な他のレコードは登録できること。
6. 再試行しても、同じ日付の同じ値が重複データとして増えないこと。
7. 体組成の登録によって、同日の体調、気分、日記、その他トレーニングを消さないこと。
8. 応答から、成功したレコードと失敗したレコード、および失敗理由を行単位で判別できること。

## 6. 機能要件

### 6.1 MCPツール

新規ツール名:

```text
save_body_metrics_batch
```

役割:

- `records[]` で受け取った複数日分の体組成を検証する。
- `dryRun=true` の場合は、書き込まずに登録予定結果を返す。
- `dryRun=false` の場合は、衝突方針に従って一括登録する。

現行 `save_body_metrics` は互換性維持のため残す。単件登録を新ツールへ内部委譲するかどうかは実装設計で決定するが、入力・検証ルールは可能な限り共通化する。

### 6.2 入力契約案

```json
{
  "records": [
    {
      "date": "2026-07-01",
      "bodyWeightKg": 68.4,
      "bodyFatPercent": 17.2,
      "bodyMetricMeasuredTimeLocal": "07:30"
    },
    {
      "date": "2026-07-02",
      "bodyWeightKg": 68.1
    }
  ],
  "timeZoneId": "Asia/Tokyo",
  "conflictPolicy": "reject",
  "dryRun": true
}
```

トップレベル:

| 項目 | 型 | 必須 | 要件 |
|---|---|---:|---|
| `records` | array | 必須 | 1〜100件 |
| `timeZoneId` | string | 任意 | IANAタイムゾーン。省略時は `Asia/Tokyo` |
| `conflictPolicy` | string | 任意 | `reject` または `overwrite`。既定は `reject` |
| `dryRun` | boolean | 必須 | `true` は検証のみ、`false` は登録 |

`records[]`:

| 項目 | 型 | 必須 | 要件 |
|---|---|---:|---|
| `date` | string | 必須 | 実在する過去日または当日、`YYYY-MM-DD` |
| `bodyWeightKg` | number | 条件付き | `(0, 500]` kg、小数2桁まで。体脂肪率との少なくとも一方を必須 |
| `bodyFatPercent` | number | 条件付き | `[0, 100]` %、小数2桁まで。体重との少なくとも一方を必須 |
| `bodyMetricMeasuredTimeLocal` | string | 任意 | 24時間表記 `HH:mm`。不明時刻を補完しない |

公開schemaには `userId`、`actorId`、`__principalUserId` を含めない。

### 6.3 入力検証

- トップレベルとレコード単位のエラーを区別する。
- MCP公開schemaでリクエスト全体を拒否する構造・プリミティブ型検証と、MCP Lambdaがレコード別結果を返す業務値検証を分離する。
- `records` が配列でない、空配列、100件超過の場合はリクエスト全体を拒否し、レコード処理を開始しない。
- 不正な `timeZoneId`、`conflictPolicy`、`dryRun`、または不明なトップレベルプロパティはリクエスト全体のエラーとする。
- `date` は書式だけでなく、うるう年を含む実在日付として検証する。
- `date` が `timeZoneId` 基準の当日より未来の場合は、そのレコードを失敗とする。
- 同じリクエスト内に同一 `date` が複数ある場合は、曖昧なマージをしない。重複した日付を持つすべてのレコードを `DUPLICATE_DATE` で失敗とし、重複しない他のレコードは処理する。
- 数値はJSON numberかつ有限値であること。文字列数値、`NaN`、`Infinity` は受け付けない。
- `bodyWeightKg` は `(0, 500]` kg、`bodyFatPercent` は `[0, 100]` %、どちらも小数2桁までとする。
- 各レコードは `bodyWeightKg` または `bodyFatPercent` の少なくとも一方を含むこと。
- `bodyMetricMeasuredTimeLocal` を指定する場合は `00:00` から `23:59` の `HH:mm` とする。
- `timeZoneId` は実在するIANAタイムゾーンとして検証する。
- レコード内の不明なプロパティは、そのレコードのエラーとして拒否する。
- 入力エラーは、配列index、日付、フィールド名、機械判定用コード、人向けメッセージを返す。
- レコード単位の検証エラーはそのレコードだけを失敗とし、検証に成功した他のレコードは処理を継続する。
- 配列要素がオブジェクトでない、または `date`、体重、体脂肪率、測定時刻のプリミティブ型が異なる場合は、Gatewayのschemaエラーとしてリクエスト全体を400で拒否できる。
- 正しいプリミティブ型で渡された値の日付実在性、未来日、数値範囲、小数桁、日付重複、不明プロパティ、既存値との競合はLambdaで検証し、レコード別結果を返す。
- 現行 `save_body_metrics` にも同じ数値範囲と小数精度を適用する。

### 6.4 既存データとの衝突

`conflictPolicy=reject`:

- 対象日に入力対象と異なる既存体組成値がある場合は `conflict` とする。
- `conflict` のレコードだけを失敗とし、競合しない他のレコードは処理を継続する。
- 既存値と入力値が同一の場合は `unchanged` とし、エラーにはしない。

`conflictPolicy=overwrite`:

- 入力で指定された体組成項目だけを新しい値で更新する。
- 入力で省略された体組成項目の既存値を保持する。
- 体調、気分、コメント、日記、その他トレーニング、作成日時など、体組成以外の既存項目を保持する。

共通:

- 新規日の `createdAt` は登録時刻とし、既存日の `createdAt` は変更しない。
- 実際に値を変更した日の `updatedAt` を登録時刻へ更新する。
- `unchanged` の日付は原則として書き込まず、`updatedAt` も変更しない。
- 値を `null` にして既存値を削除する操作は受け付けない。

### 6.5 部分成功と同時更新

- `dryRun=false` の1回の呼び出しでは、検証に成功したレコードを日付単位で独立して登録する。
- 1件の失敗を理由に、成功可能な他のレコードをロールバックしない。
- 各レコードの更新自体は原子的に実行し、中途半端な1レコードを作らない。
- 各レコードの書き込み直前にも既存値との衝突条件を検査する。
- `dryRun` 後に別の更新が入った場合、実登録時の状態を正として再検証する。
- 同時に更新された体組成値を無条件に上書きしない。
- 体組成だけを更新対象とし、同時に更新された日記などの非対象項目を失わない。
- 同一入力の再試行は、`unchanged` または同等の成功結果となる冪等な動作にする。
- 一時的な書き込みエラーが発生したレコードは `WRITE_FAILED` として返し、他のレコードは処理を継続する。
- 呼び出し元は失敗レコードだけを再送できる。リクエスト全体を再送した場合も、先に成功したレコードは `unchanged` となる。
- Lambda停止やタイムアウトなどで全レコードの結果を返せない場合は、可能であれば500と追跡用IDを返す。呼び出し元はリクエスト全体を安全に再送でき、先に保存済みのレコードは冪等に `unchanged` として扱われること。

### 6.6 実行前確認

- AIは受け取ったデータを日付、体重、体脂肪率、測定時刻の一覧としてユーザーへ提示する。
- AIは最初に `dryRun=true` で登録予定結果と衝突を確認する。
- AIはユーザーから登録の明示指示を受けた後に限り `dryRun=false` を呼び出す。
- 既存値を変更する場合は、上書き対象日と件数を示し、上書きの明示同意を得る。
- ユーザーが最初から内容と登録実行を明示している場合は、通常の登録確認を省略できる。
- 通常の登録確認を省略する場合もdry-runは実施し、上書き対象が判明した場合は改めて明示同意を得る。

注記:

- この確認フローはAIの誤操作を減らすための要件であり、認可境界ではない。認可はGatewayのJWT検証で必ず実施する。

### 6.7 応答契約

部分成功:

```json
{
  "tool": "save_body_metrics_batch",
  "requestId": "3e8dfb9f-9f4f-4fa8-b9ab-08499f8b6f75",
  "dryRun": false,
  "conflictPolicy": "reject",
  "outcome": "partially_succeeded",
  "summary": {
    "received": 3,
    "succeeded": 2,
    "failed": 1,
    "created": 1,
    "updated": 0,
    "unchanged": 1,
    "conflicts": 1
  },
  "results": [
    {
      "index": 0,
      "recordDate": "2026-07-01",
      "status": "success",
      "action": "unchanged",
      "input": {
        "date": "2026-07-01",
        "bodyWeightKg": 68.4,
        "bodyFatPercent": 17.2,
        "bodyMetricMeasuredTimeLocal": "07:30"
      }
    },
    {
      "index": 1,
      "recordDate": "2026-07-02",
      "status": "success",
      "action": "created",
      "input": {
        "date": "2026-07-02",
        "bodyWeightKg": 68.1
      }
    },
    {
      "index": 2,
      "recordDate": "2026-07-03",
      "status": "failed",
      "input": {
        "date": "2026-07-03",
        "bodyWeightKg": 67.9
      },
      "error": {
        "field": "bodyWeightKg",
        "code": "CONFLICT",
        "message": "A different body weight is already recorded for this date."
      }
    }
  ]
}
```

dry-runでは、書き込み予定の正常レコードに `would_create` または `would_update`、変更不要なレコードに `unchanged` を `action` として返す。

リクエスト全体の入力エラー:

```json
{
  "message": "records must contain between 1 and 100 items.",
  "code": "INVALID_BATCH_SIZE",
  "requestId": "3e8dfb9f-9f4f-4fa8-b9ab-08499f8b6f75"
}
```

要件:

- 応答から内部 `userId` を除外する。
- 応答はログと照合できる追跡用 `requestId` を持つ。
- トップレベルの `outcome` は `succeeded`、`partially_succeeded`、`failed` のいずれかとする。
- リクエスト全体を受理した場合、`results` は入力レコードと同じ件数を入力順で返す。
- 各結果の `status` は `success` または `failed` とする。
- 成功結果の `action` は、実登録時は `created`、`updated`、`unchanged`、dry-run時は `would_create`、`would_update`、`unchanged` のいずれかとする。
- 失敗結果は `error.field`、`error.code`、`error.message` を持つ。
- 各結果は `index` と入力値を持ち、元のどのレコードか判別できること。
- 日付を正規化できた結果は `recordDate` を持つ。日付自体が不正な場合も、`index` と `input.date` で入力行を識別できること。
- `summary.succeeded + summary.failed = summary.received` を満たすこと。
- レコード単位の主なエラーコードは、少なくとも `INVALID_RECORD`、`UNKNOWN_PROPERTY`、`INVALID_DATE`、`FUTURE_DATE`、`DUPLICATE_DATE`、`OUT_OF_RANGE`、`TOO_MANY_DECIMALS`、`CONFLICT`、`CONCURRENT_UPDATE`、`READ_FAILED`、`WRITE_FAILED` を区別する。
- エラー応答にJWT、Authorizationヘッダー、内部テーブル名、スタックトレースを含めない。
- 予期しない内部エラーの詳細はクライアントへ返さず、追跡用IDだけを返す。

### 6.8 HTTP相当ステータス

| 状態 | statusCode |
|---|---:|
| 全件成功・部分成功・全レコード失敗 / dry-run完了 | 200 |
| リクエスト全体のschema・トップレベル入力不正 | 400 |
| 認証情報なし・無効 | 401 |
| ユーザー偽装・内部identity直接指定 | 403 |
| 上限超過 | 400 |
| 予期しない内部エラー | 500 |

レコード単位の入力不正、既存値との衝突、同時更新競合、書き込み失敗はHTTP相当ステータスを変えず、200応答内の `results[].status=failed` と `error.code` で表す。これによりMCPクライアントが成功・失敗の混在結果を必ず受け取れるようにする。

## 7. セキュリティ・プライバシー要件

- ユーザー識別子の正は、Gateway REQUEST Interceptorが検証したCognitoアクセストークンのJWT `sub` だけとする。
- MCP Lambdaは内部引数 `__principalUserId` だけを使用し、公開引数やモデル出力のidentityへfallbackしない。
- すべての取得・更新条件に検証済み `userId` を含め、他ユーザーの `DailyRecord` を参照・更新できないようにする。
- 呼び出し元が `userId`、`actorId`、`__principalUserId` を指定した場合は、既存のMCPセキュリティ設計に従って拒否または除去する。
- JWT、Authorizationヘッダー、Cognito属性、体重・体脂肪率の全入力配列を通常ログへ出力しない。
- 運用ログには、ツール名、件数、成功/失敗、処理時間、追跡用IDを記録できる。
- エラー調査のため値を記録する必要がある場合も、明示的なマスキング方針と保存期間を別途定める。

## 8. 非機能要件

### 8.1 性能・制限

- 1回の上限件数を公開schemaとLambdaの両方で制限する。
- 最大件数のdry-runと実登録が、現行MCP Lambdaのタイムアウト30秒以内に完了すること。
- DynamoDB `Scan` は使用しない。
- 対象データの取得と更新は、検証済み `userId` と `recordDate` をキーに行う。
- リクエストと応答がMCPクライアントおよびモデルの実用的なコンテキストサイズに収まること。

### 8.2 可用性・再試行

- 一時的なDynamoDBエラーや競合を、入力不正と区別できること。
- 安全に再試行できる応答とする。
- 成功レコードと失敗レコードを分離して再試行できること。
- Lambda内部で自動再試行する場合は回数を制限し、30秒タイムアウトを超えないこと。

### 8.3 保守性

- 単件登録と一括登録の、日付、時刻、数値、タイムゾーン検証を共通化する。
- 公開JSON SchemaとLambda側検証の差異をテストで検出する。
- 新規ツール追加後もidentity引数が公開schemaに含まれないことを自動テストする。
- `docs/spec.md` と `docs/ai-implementation-spec.md` の公開ツール一覧を実装時に更新する。

### 8.4 監視

最低限、次を集計可能にする。

- 呼び出し回数
- dry-run回数 / 実登録回数
- 入力件数
- succeeded / failed / created / updated / unchanged / conflict件数
- 400 / 401 / 403 / 500件数
- 処理時間
- DynamoDB競合・スロットリング件数

体重・体脂肪率そのものをメトリクスのdimensionやログへ含めない。

## 9. 受け入れ条件

1. 2日以上の正しい入力を1回のツール呼び出しで登録できる。
2. 登録後、`get_daily_records` と `get_daily_record` で値を確認できる。
3. `dryRun=true` ではDynamoDBが変更されない。
4. レコード単位の入力エラーがあっても、正しい他のレコードを登録できる。
5. `conflictPolicy=reject` で異なる既存値がある場合、競合レコードだけが失敗し、他のレコードは登録できる。
6. `conflictPolicy=overwrite` で、入力した体組成項目だけを更新できる。
7. 体組成更新後も、同日の体調、気分、コメント、日記、その他トレーニングが保持される。
8. 同一入力を再送しても重複データが作られず、既存値と `updatedAt` が不要に変わらない。
9. 同一リクエスト内で重複する日付は、該当するすべての行が `DUPLICATE_DATE` で失敗し、重複しない行は処理される。
10. 実在しない日付、未来日、不正時刻、範囲外数値はレコード別の失敗として返る。
11. 不正タイムゾーンや100件超過はリクエスト全体の400として返り、書き込みを開始しない。
12. `userId` 等のidentity引数が公開schemaに存在しない。
13. 別ユーザーのデータを取得・更新できない。
14. JWT、Authorizationヘッダー、測定値一覧が通常ログへ出力されない。
15. 同時更新競合で、後から書かれた体組成値や非対象のDaily項目を消さない。
16. 受理したリクエストの `results` が入力と同じ件数・同じ順序で返り、各レコードの `success` / `failed` と理由を判別できる。
17. 成功・失敗が混在する場合は `outcome=partially_succeeded` とHTTP相当200を返す。
18. 全レコードがレコード単位の理由で失敗した場合も、全失敗結果を含む `outcome=failed` とHTTP相当200を返す。
19. 正しいプリミティブ型で渡された日付・数値の業務値エラーや不明プロパティが、Gatewayで拒否されずLambdaのレコード別結果として返る。

## 10. 実装時の主な変更候補

- `amplify/agentcore/tool-schemas/mcp-tools.json`
  - `save_body_metrics_batch` の公開schema追加
- `amplify/functions/mcp-tools-api/handler.ts`
  - 一括検証、dry-run、衝突検出、レコード単位の書き込み、部分成功応答の整形
- `tests/mcp-tools-interface.test.ts`
  - schema、値域、重複日付、上限、dry-run、衝突、部分成功、冪等性
- `tests/mcp-identity-interceptor.test.ts`
  - 新規ツールでもidentity引数が公開されないこと
- `amplify/agentcore/runtime/config/prompts/system-prompt.ja.txt`
  - 登録前確認、dry-run、上書き確認のルール
- `docs/spec.md`
  - 体組成管理とMCP公開ツール一覧
- `docs/ai-implementation-spec.md`
  - Gateway公開ツールと検証要件

## 11. 決定事項

2026-07-23にD-01〜D-13を確定した。D-04は部分成功を採用し、それ以外は初期推奨案を採用する。

| ID | 判断事項 | 選択肢 | 決定 | 影響 |
|---|---|---|---|---|
| D-01 | 片方だけの登録を許すか | A: 体重・体脂肪率を両方必須 / B: 少なくとも片方を必須 | **B**。過去データでは体重だけの記録が多く、入力欠損を捏造せず登録できる | schema、既存値保持、受け入れテスト |
| D-02 | 測定時刻を必須にするか | A: 全行必須 / B: 任意 / C: 未指定時に固定時刻を補完 | **B**。不明な時刻を作らない。指定がなければ既存値を保持し、新規日は時刻なし | 現行単件ツールとの差、Daily表示 |
| D-03 | 既存値の扱い | A: 常に拒否 / B: 常に上書き / C: `reject` と `overwrite` を明示指定 | **C**。既定は `reject` とし、明示同意時だけ `overwrite` | 安全性、AI確認フロー、レコード別競合応答 |
| D-04 | 一部成功を許すか | A: 全件成功/全件失敗 / B: 正常行だけ登録 | **B**。正常レコードは登録し、失敗レコードと理由を戻り値で識別可能にする | レコード単位の書き込み、部分成功応答、再試行 |
| D-05 | 1回の最大件数 | A: 31件 / B: 100件 / C: 366件以上 | **B: 100件**。実用性とMCP payload、処理時間のバランスを取る | 処理時間、応答サイズ、schema |
| D-06 | 数値範囲と小数精度 | A: 現行踏襲（体重 `>0`、体脂肪率 `0..100`、精度制限なし） / B: 現実的上限と小数桁を追加 | **B**。体重 `(0,500]kg`、体脂肪率 `[0,100]%`、小数2桁まで。単件側も同時に統一 | 既存仕様との互換性、入力検証 |
| D-07 | dry-runを必須フローにするか | A: `dryRun` なし / B: 任意指定 / C: AIは必ずdry-run後に実登録 | **C**。ツール機能としては真偽を受け、AI運用ではdry-runを必須にする | ツール呼び出し回数、安全性 |
| D-08 | 未来日の登録 | A: 許可 / B: 拒否 / C: 警告は返すが許可 | **B**。日付誤入力を防ぐ。必要なら明示オプションを将来追加 | 日付検証、タイムゾーン基準の「今日」判定 |
| D-09 | タイムゾーンの粒度 | A: リクエスト全体で1つ / B: 行ごとに指定可能 | **A**。初版を単純化する。旅行など複数地域のデータはリクエストを分ける | schema、保存値 |
| D-10 | 入力形式 | A: 構造化 `records[]` のみ / B: CSV文字列もツールが直接受ける | **A**。解析の曖昧さをMCP書き込みツールへ持ち込まない | Lambda責務、入力エラー |
| D-11 | 登録前のユーザー確認 | A: 毎回必要 / B: 上書き時だけ必要 / C: 明示的な登録依頼がすでにある場合は省略可 | **C**。ただし上書き対象がdry-runで判明した場合は再確認する | システムプロンプト、UX |
| D-12 | 不明な入力プロパティ | A: 拒否 / B: 無視 | **A**。列名の取り違えやAIの引数ミスを早期検出する | JSON Schema、Lambda検証 |
| D-13 | 既存単件ツールとの値域統一 | A: 一括ツールだけ新ルール / B: 単件・一括を同時に統一 | **B**。同じデータに異なる検証を持たせない | 既存テスト、互換性確認 |

## 12. 確定仕様概要

- 新規ツール: `save_body_metrics_batch`
- 入力は構造化された `records[]` のみ
- 1回1〜100件
- 日付は行ごとに必須。同一リクエスト内の重複日はマージせず該当行を失敗とし、他の行は処理する
- 体重または体脂肪率の少なくとも一方を必須
- 測定時刻は任意で、不明値を補完しない
- タイムゾーンはリクエスト全体で1つ
- `conflictPolicy` は `reject` / `overwrite`、安全側の既定は `reject`
- dry-runで差分を確認後、明示指示を受けて実登録
- 正常レコードは登録し、入力不正・競合・書き込み失敗のレコードは失敗として返す
- 戻り値は入力全件について `success` / `failed`、実行内容または失敗理由を返す
- 部分成功でもHTTP相当200とし、`outcome=partially_succeeded` で表す
- 同じ値の再送は `unchanged`
- 未来日は拒否
- 体組成以外のDaily項目は必ず保持
- CSVなどの解析はAIまたは呼び出し元が担当

## 13. 実装時に作成する成果物

1. DynamoDBのレコード単位更新・競合制御を含む実装設計
2. MCP JSON Schema
3. Lambda単体・結合テスト項目
4. Runtimeの登録前確認ルール
5. `docs/spec.md` と `docs/ai-implementation-spec.md` の更新
