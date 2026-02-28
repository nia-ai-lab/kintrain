# KinTrain Mock UI

## 概要

仕様確認用のモックSPAです。
- framework: React + Vite + TypeScript
- 主要画面: dashboard / training-session / training-menu / calendar / daily / ai-chat
- 主要画面: dashboard / training-session / training-menu / calendar / daily / ai-chat / settings
- データ保存: localStorage（`kintrain-mock-ui-v1`）

## 起動

```bash
cd frontend
npm install
npm run dev
```

## 補足

- AIチャットはストリーミング表示のモック実装です（実AI接続なし）。
- 既定キャラクターは `nyaruko` を利用します。
- 画像は `public/assets/characters/nyaruko/` 配下を参照します。
