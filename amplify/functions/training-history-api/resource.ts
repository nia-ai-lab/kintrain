import { defineFunction } from "@aws-amplify/backend";

export const trainingHistoryApiFunction = defineFunction({
  name: "kintrain-training-history-api",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512,
  logging: { retention: "1 month" }
});
