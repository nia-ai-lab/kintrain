import { defineFunction } from "@aws-amplify/backend";

export const mcpIdentityInterceptorFunction = defineFunction({
  name: "kintrain-mcp-identity-interceptor",
  entry: "./handler.ts",
  timeoutSeconds: 10,
  memoryMB: 256
});
