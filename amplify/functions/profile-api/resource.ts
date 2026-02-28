import { defineFunction } from "@aws-amplify/backend";

export const profileApiFunction = defineFunction({
  name: "kintrain-profile-api",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512
});
