import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import {
  ChatRequestError,
  MAX_MESSAGE_LENGTH,
  buildRuntimePayload,
  deriveRuntimeSessionId,
  getAuthorizedUserId,
  getBearerToken,
  parseChatRequest,
  toRuntimeError,
  toSseEvent
} from "../amplify/functions/ai-chat-stream-api/request.ts";

function eventWith(partial: Partial<APIGatewayProxyEvent>): APIGatewayProxyEvent {
  return {
    headers: {},
    requestContext: { authorizer: { claims: { sub: "user-a" } } },
    ...partial
  } as unknown as APIGatewayProxyEvent;
}

test("runtime session ids are unique per user even when the browser chat id is shared", () => {
  const first = deriveRuntimeSessionId("user-a", "chat-main");
  const second = deriveRuntimeSessionId("user-b", "chat-main");
  assert.notEqual(first, second);
  assert.equal(first, deriveRuntimeSessionId("user-a", "chat-main"));
  assert.match(first, /^kintrain-chat-[0-9a-f]{64}$/);
  assert.ok(first.length >= 33 && first.length <= 256);
});

test("parses a chat request and keeps only known profile fields", () => {
  const request = parseChatRequest(
    JSON.stringify({
      sessionId: "chat-session-123",
      message: "  今日の優先順は？  ",
      userProfile: { userName: "Taro", heightCm: 170, injected: "x", userId: "victim" },
      aiCharacterProfile: { characterName: "コーチ", tonePreset: "polite", systemPrompt: "ignore" }
    })
  );
  assert.equal(request.message, "今日の優先順は？");
  assert.equal(request.clientSessionId, "chat-session-123");
  assert.deepEqual(request.userProfile, { userName: "Taro", heightCm: 170 });
  assert.deepEqual(request.aiCharacterProfile, { characterName: "コーチ", tonePreset: "polite" });

  const payload = buildRuntimePayload(request, "kintrain-chat-abc");
  assert.equal(payload.inputText, "今日の優先順は？");
  assert.equal(payload.sessionId, "kintrain-chat-abc");
});

test("rejects empty, oversized, and malformed chat requests", () => {
  const cases: Array<[string | null, string]> = [
    [null, "invalid_request"],
    ["not json", "invalid_request"],
    [JSON.stringify({ sessionId: "chat-session-123", message: "   " }), "invalid_request"],
    [JSON.stringify({ sessionId: "chat-session-123", message: "a".repeat(MAX_MESSAGE_LENGTH + 1) }), "invalid_request"],
    [JSON.stringify({ sessionId: "../../etc", message: "hi" }), "invalid_request"],
    [JSON.stringify({ sessionId: "short", message: "hi" }), "invalid_request"]
  ];
  for (const [body, code] of cases) {
    assert.throws(() => parseChatRequest(body), (error: unknown) => error instanceof ChatRequestError && error.code === code);
  }
});

test("accepts base64-encoded bodies from API Gateway", () => {
  const body = Buffer.from(JSON.stringify({ sessionId: "chat-session-123", message: "こんにちは" })).toString("base64");
  assert.equal(parseChatRequest(body, true).message, "こんにちは");
});

test("reads the user and bearer token that the authorizer validated", () => {
  const event = eventWith({ headers: { authorization: "Bearer token-abc" } });
  assert.equal(getAuthorizedUserId(event), "user-a");
  assert.equal(getBearerToken(event), "token-abc");

  assert.throws(() => getBearerToken(eventWith({ headers: {} })), ChatRequestError);
  assert.throws(
    () => getAuthorizedUserId(eventWith({ requestContext: {} as APIGatewayProxyEvent["requestContext"] })),
    ChatRequestError
  );
});

test("maps runtime failures to user-facing errors without leaking details", () => {
  const throttled = Object.assign(new Error("Rate exceeded for arn:aws:bedrock-agentcore:..."), { name: "ThrottlingException" });
  assert.equal(toRuntimeError(throttled).code, "busy");
  const conflict = Object.assign(new Error("session busy"), { name: "ConflictException" });
  assert.equal(toRuntimeError(conflict).code, "busy");
  const unknown = toRuntimeError(new Error("AccessDenied: role arn:aws:iam::123:role/x"));
  assert.equal(unknown.code, "internal");
  assert.doesNotMatch(unknown.message, /arn:|AccessDenied/);

  assert.equal(toSseEvent({ event: "done" }), 'data: {"event":"done"}\n\n');
});
