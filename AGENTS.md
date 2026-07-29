# KinTrain 作業ルール

## デプロイに関する最優先ルール

このプロジェクトの `dev` / `main` 環境へのデプロイは、**GitHubの対象ブランチへのpushを起点にAmplifyが自動実行する方式だけ**を使用する。

- `git push origin dev`
  - Amplifyがdev環境のバックエンドとフロントエンドを自動デプロイする。
- `dev` で検証した変更を `main` に取り込み、`git push origin main`
  - Amplifyが本番環境のバックエンドとフロントエンドを自動デプロイする。

AIエージェントは、`dev` / `main` を更新する目的で以下を直接実行してはならない。

- `ampx pipeline-deploy`
- `ampx sandbox` または `scripts/deploy-backend.sh`
- `scripts/deploy-frontend.sh` またはHosting用バケットへの `aws s3 sync`
- `cdk deploy`
- CloudFormationスタックの作成・更新・削除
- AmplifyのデプロイジョブをAWS CLIやSDKから手動開始

「デプロイして」と依頼された場合も、上記コマンドを使わず、変更のcommitとGitHubへのpushによって実施する。`main` へのpushは本番デプロイになるため、ユーザーが本番反映を明示した場合だけ行う。

この制約はデプロイ方式に対するものであり、ユーザーが依頼したDynamoDBデータ操作、Cognitoユーザー操作、ログ・設定の参照まで一律に禁止するものではない。ただし、AWSリソース構成を変更する操作は直接実行せず、コード化してGitHubへのpushによるAmplifyデプロイへ載せる。

詳細と確認手順は `docs/deployment.md` を正本とする。
