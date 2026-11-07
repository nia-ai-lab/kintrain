import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { APIGatewayProxyEvent } from "aws-lambda";
import type { Writable } from "node:stream";
import {
  ChatRequestError,
  buildRuntimePayload,
  deriveRuntimeSessionId,
  getAuthorizedUserId,
  getBearerToken,
  parseChatRequest,
  toRuntimeError,
  toSseEvent
} from "./request";

type ResponseMetadata = { statusCode: number; headers: Record<string, string> };

declare const awslambda: {
  streamifyResponse(
    handler: (event: APIGatewayProxyEvent, responseStream: Writable) => Promise<void>
  ): (event: APIGatewayProxyEvent, responseStream: Writable) => Promise<void>;
  HttpResponseStream: {
    from(responseStream: Writable, metadata: ResponseMetadata): Writable;
  };
};

const RUNTIME_ARN = process.env.AI_RUNTIME_ARN ?? "";
const RUNTIME_QUALIFIER = process.env.AI_RUNTIME_QUALIFIER ?? "DEFAULT";
const USER_ACCESS_TOKEN_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Custom-User-Access-Token";
const HEARTBEAT_INTERVAL_MS = 15_000;
// Longer than any normal turn, shorter than the Lambda timeout so the client always gets an error event.
const RUNTIME_TIMEOUT_MS = 9 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

const client = new BedrockAgentCoreClient({});

function sendError(responseStream: Writable, error: ChatRequestError): void {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: error.statusCode,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
  stream.write(JSON.stringify({ code: error.code, message: error.message }));
  stream.end();
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  let request;
  let userId: string;
  let userAccessToken: string;
  try {
    if (!RUNTIME_ARN) {
      throw new ChatRequestError(503, "internal", "AIコーチは現在利用できません。");
    }
    userId = getAuthorizedUserId(event);
    userAccessToken = getBearerToken(event);
    request = parseChatRequest(event.body, event.isBase64Encoded);
  } catch (error) {
    sendError(responseStream, toRuntimeError(error));
    return;
  }

  const runtimeSessionId = deriveRuntimeSessionId(userId, request.clientSessionId);
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform"
    }
  });
  // An early byte lets the browser show the request as connected right away.
  stream.write(": connected\n\n");
  const heartbeat = setInterval(() => stream.write(": keep-alive\n\n"), HEARTBEAT_INTERVAL_MS);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), RUNTIME_TIMEOUT_MS);

  try {
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN,
      qualifier: RUNTIME_QUALIFIER,
      runtimeSessionId,
      contentType: "application/json",
      accept: "text/event-stream",
      payload: Buffer.from(JSON.stringify(buildRuntimePayload(request, runtimeSessionId)))
    });
    // Added before signing so the header is covered by SigV4. The runtime verifies the
    // token itself and uses it for the MCP Gateway, which verifies it again.
    command.middlewareStack.add(
      (next) => async (args) => {
        (args.request as { headers: Record<string, string> }).headers[USER_ACCESS_TOKEN_HEADER] = userAccessToken;
        return next(args);
      },
      { step: "build", name: "addUserAccessTokenHeader" }
    );

    const result = await client.send(command, { abortSignal: abortController.signal });
    const body = result.response as AsyncIterable<Uint8Array> | undefined;
    if (!body) {
      throw new Error("AgentCore Runtime returned an empty response.");
    }
    for await (const chunk of body) {
      stream.write(chunk);
    }
  } catch (error) {
    const chatError = toRuntimeError(error);
    console.error(
      JSON.stringify({
        message: "ai-chat-runtime-invoke-failed",
        code: chatError.code,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      })
    );
    stream.write(toSseEvent({ event: "error", code: chatError.code, message: chatError.message }));
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    stream.end();
  }
});
