import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  processInterceptorEvent,
  resolveUserPoolClientIds
} from "../amplify/functions/mcp-identity-interceptor/handler.ts";

type JsonObject = Record<string, unknown>;

const principalUserId = "user-a-sub";

function eventFor(argumentsObject: JsonObject, authorization = "Bearer valid-token"): JsonObject {
  return {
    interceptorInputVersion: "1.0",
    mcp: {
      gatewayRequest: {
        headers: { Authorization: authorization },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_daily_records",
            arguments: argumentsObject
          }
        }
      }
    }
  };
}

const verifyAsPrincipal = async () => ({ sub: principalUserId });

test("multiple Cognito app client IDs are parsed and deduplicated", () => {
  assert.deepEqual(
    resolveUserPoolClientIds(
      "frontend-client, chatgpt-client, claude-client,frontend-client",
      undefined
    ),
    ["frontend-client", "chatgpt-client", "claude-client"]
  );
});

test("legacy single Cognito app client ID remains supported", () => {
  assert.deepEqual(resolveUserPoolClientIds(undefined, "legacy-client"), ["legacy-client"]);
});

function transformedArguments(output: JsonObject): JsonObject {
  const mcp = output.mcp as JsonObject;
  const request = mcp.transformedGatewayRequest as JsonObject;
  const body = request.body as JsonObject;
  const params = body.params as JsonObject;
  return params.arguments as JsonObject;
}

function responseStatus(output: JsonObject): number {
  const mcp = output.mcp as JsonObject;
  const response = mcp.transformedGatewayResponse as JsonObject;
  return response.statusCode as number;
}

test("JWT sub is injected when the model supplies no user identity", async () => {
  const output = await processInterceptorEvent(eventFor({ from: "2026-07-01" }), verifyAsPrincipal);
  assert.deepEqual(transformedArguments(output), {
    from: "2026-07-01",
    __principalUserId: principalUserId
  });
});

test("matching legacy userId is removed and replaced with trusted identity", async () => {
  const output = await processInterceptorEvent(eventFor({ userId: principalUserId }), verifyAsPrincipal);
  assert.deepEqual(transformedArguments(output), { __principalUserId: principalUserId });
});

test("a different userId is rejected", async () => {
  const output = await processInterceptorEvent(eventFor({ userId: "user-b-sub" }), verifyAsPrincipal);
  assert.equal(responseStatus(output), 403);
});

test("a caller cannot supply the reserved trusted identity", async () => {
  const output = await processInterceptorEvent(
    eventFor({ __principalUserId: principalUserId }),
    verifyAsPrincipal
  );
  assert.equal(responseStatus(output), 403);
});

test("missing or invalid authorization is rejected", async () => {
  const missing = await processInterceptorEvent(eventFor({}, ""), verifyAsPrincipal);
  assert.equal(responseStatus(missing), 401);

  const invalid = await processInterceptorEvent(eventFor({}), async () => {
    throw new Error("invalid token");
  });
  assert.equal(responseStatus(invalid), 401);
});

test("non-tool MCP requests pass through without identity injection", async () => {
  const event = {
    mcp: {
      gatewayRequest: {
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
      }
    }
  };
  const output = await processInterceptorEvent(event, verifyAsPrincipal);
  const mcp = output.mcp as JsonObject;
  const request = mcp.transformedGatewayRequest as JsonObject;
  assert.deepEqual(request.body, event.mcp.gatewayRequest.body);
});

test("public MCP schemas do not expose user identity fields", async () => {
  const raw = await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8");
  const schemas = JSON.parse(raw) as Array<{ inputSchema: { properties: JsonObject; required?: string[] } }>;
  for (const schema of schemas) {
    assert.equal(Object.hasOwn(schema.inputSchema.properties, "userId"), false);
    assert.equal(Object.hasOwn(schema.inputSchema.properties, "actorId"), false);
    assert.equal(Object.hasOwn(schema.inputSchema.properties, "__principalUserId"), false);
    assert.equal(schema.inputSchema.required?.includes("userId") ?? false, false);
  }
});

test("backend provisions and allowlists a dedicated Claude OAuth app client", async () => {
  const source = await readFile("amplify/backend.ts", "utf8");
  assert.match(source, /addClient\("ClaudeOAuthClient"/);
  assert.match(source, /KinTrain-Claude-\$\{deploymentBranchSuffix\}/);
  assert.match(source, /https:\/\/claude\.ai\/api\/mcp\/auth_callback/);
  assert.match(
    source,
    /chatGptOAuthClient\.userPoolClientId,\s*claudeOAuthClient\.userPoolClientId/
  );
  assert.match(source, /claudeOAuth:\s*\{\s*clientId: claudeOAuthClient\.userPoolClientId/);
});

test("gateway uses stable AgentCore CDK and supports all required MCP protocol versions", async () => {
  const source = await readFile("amplify/backend.ts", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    devDependencies: Record<string, string>;
  };

  assert.match(source, /from "aws-cdk-lib\/aws-bedrockagentcore"/);
  assert.equal(Object.hasOwn(packageJson.devDependencies, "@aws-cdk/aws-bedrock-agentcore-alpha"), false);
  assert.match(
    source,
    /supportedVersions:\s*\[\s*agentcore\.MCPProtocolVersion\.of\("2026-07-28"\),\s*agentcore\.MCPProtocolVersion\.of\("2025-11-25"\),\s*agentcore\.MCPProtocolVersion\.MCP_2025_06_18,\s*agentcore\.MCPProtocolVersion\.MCP_2025_03_26\s*\]/
  );
});
