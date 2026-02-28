import { defineFunction } from "@aws-amplify/backend";

export const trainingMenuApiFunction = defineFunction({
  name: "kintrain-training-menu-api",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512
});
