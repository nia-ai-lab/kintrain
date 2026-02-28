import { defineFunction } from "@aws-amplify/backend";

export const aiSettingsApiFunction = defineFunction({
  name: "kintrain-ai-settings-api",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512
});
