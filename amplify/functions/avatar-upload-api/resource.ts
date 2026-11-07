import { defineFunction } from "@aws-amplify/backend";

export const avatarUploadApiFunction = defineFunction({
  name: "kintrain-avatar-upload-api",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512,
  logging: { retention: "1 month" }
});
