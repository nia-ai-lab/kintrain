import { defineFunction } from "@aws-amplify/backend";

export const mcpToolsApiFunction = defineFunction({
  name: "kintrain-mcp-tools-api",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512
});
