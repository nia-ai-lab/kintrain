# KinTrain Frontend

## 概要

React + Vite + TypeScriptで実装したSPAです。Cognito認証後、Core APIでプロフィール、メニューセット、トレーニング履歴、Daily、目標、AI設定、アバターを読書きします。AI Runtimeが設定された環境では、AIチャットとAIメニュー生成をSSEで実行します。

ローカルストレージキー `kintrain-mock-ui-v2` は、トレーニング実施中の下書き等のUI状態保存に使用します。業務データの正本はバックエンドです。AIメニュー生成の会話中状態はセッションストレージへ保存します。

## 起動

リポジトリルートで、デプロイ済みブランチの接続情報を同期して起動します。

```bash
npm ci
npm run dev
```

フロントだけ起動する場合:

```bash
npm run frontend:dev
```

## ビルド

```bash
npm run frontend:build
```

接続情報、ビルド、デプロイの詳細は `docs/deployment.md` を参照してください。`frontend/src/amplify_outputs.json` は環境固有の生成物であり、Git管理対象外です。
