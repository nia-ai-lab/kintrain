import { defineFunction } from "@aws-amplify/backend";

export const dailyRecordApiFunction = defineFunction({
  name: "kintrain-daily-record-api",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512
});
