import { defineFunction } from "@aws-amplify/backend";

export const coachingContextApiFunction = defineFunction({
  name: "kintrain-coaching-context-api",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512,
  logging: { retention: "1 month" }
});
