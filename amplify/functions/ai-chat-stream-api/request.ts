import { createHash } from "node:crypto";
import type { APIGatewayProxyEvent } from "aws-lambda";

export const MAX_MESSAGE_LENGTH = 4000;
const MAX_PROFILE_FIELD_LENGTH = 400;
const CLIENT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

const userProfileFields = ["userName", "sex", "birthDate", "timeZoneId"] as const;
const aiCharacterProfileFields = ["characterName", "tonePreset", "characterDescription", "speechEnding"] as const;

export type ChatRequest = {
  message: string;
  clientSessionId: string;
  userProfile: Record<string, string | number>;
  aiCharacterProfile: Record<string, string>;
};

export type ChatErrorCode = "invalid_request" | "unauthorized" | "busy" | "timeout" | "internal";

export class ChatRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ChatErrorCode,
    message: string
  ) {
    super(message);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pickStrings<const K extends readonly string[]>(source: unknown, keys: K): Record<string, string> {
  const object = asObject(source);
  const picked: Record<string, string> = {};
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) {
      picked[key] = value.trim().slice(0, MAX_PROFILE_FIELD_LENGTH);
    }
  }
  return picked;
}

export function getHeader(event: Pick<APIGatewayProxyEvent, "headers">, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === expected && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/** The Cognito access token that API Gateway's authorizer already validated. */
export function getBearerToken(event: Pick<APIGatewayProxyEvent, "headers">): string {
  const authorization = getHeader(event, "Authorization")?.trim() ?? "";
  const token = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  if (!token) {
    throw new ChatRequestError(401, "unauthorized", "ログイン情報を確認できませんでした。ページを再読み込みしてください。");
  }
  return token;
}

export function getAuthorizedUserId(event: Pick<APIGatewayProxyEvent, "requestContext">): string {
  const claims = (event.requestContext.authorizer as { claims?: Record<string, string> } | undefined)?.claims;
  const sub = claims?.sub?.trim();
  if (!sub) {
    throw new ChatRequestError(401, "unauthorized", "ログイン情報を確認できませんでした。ページを再読み込みしてください。");
  }
  return sub;
}

export function parseChatRequest(body: string | null | undefined, isBase64Encoded = false): ChatRequest {
  let parsed: unknown;
  try {
    const raw = isBase64Encoded && body ? Buffer.from(body, "base64").toString("utf8") : body ?? "";
    parsed = JSON.parse(raw);
  } catch {
    throw new ChatRequestError(400, "invalid_request", "送信内容を読み取れませんでした。");
  }
  const object = asObject(parsed);

  const message = typeof object.message === "string" ? object.message.trim() : "";
  if (!message) {
    throw new ChatRequestError(400, "invalid_request", "メッセージを入力してください。");
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new ChatRequestError(400, "invalid_request", `メッセージは${MAX_MESSAGE_LENGTH}文字以内で入力してください。`);
  }

  const clientSessionId = typeof object.sessionId === "string" ? object.sessionId.trim() : "";
  if (!CLIENT_SESSION_ID_PATTERN.test(clientSessionId)) {
    throw new ChatRequestError(400, "invalid_request", "チャットの状態が不正です。新しいチャットを開始してください。");
  }

  const userProfile: Record<string, string | number> = pickStrings(object.userProfile, userProfileFields);
  const heightCm = asObject(object.userProfile).heightCm;
  if (typeof heightCm === "number" && Number.isFinite(heightCm) && heightCm > 0 && heightCm < 300) {
    userProfile.heightCm = heightCm;
  }

  return {
    message,
    clientSessionId,
    userProfile,
    aiCharacterProfile: pickStrings(object.aiCharacterProfile, aiCharacterProfileFields)
  };
}

/**
 * AgentCore Runtime sessions are shared by every caller that sends the same id, so the
 * id is derived from the verified user and the browser's chat id. Two users can never
 * land in the same runtime session even if their browsers send the same chat id.
 */
export function deriveRuntimeSessionId(userId: string, clientSessionId: string): string {
  const digest = createHash("sha256").update(`${userId}\u0000${clientSessionId}`).digest("hex");
  return `kintrain-chat-${digest}`;
}

export function buildRuntimePayload(request: ChatRequest, runtimeSessionId: string): Record<string, unknown> {
  return {
    inputText: request.message,
    sessionId: runtimeSessionId,
    metadata: {
      userProfile: request.userProfile,
      aiCharacterProfile: request.aiCharacterProfile
    }
  };
}

export function toSseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function toRuntimeError(error: unknown): ChatRequestError {
  if (error instanceof ChatRequestError) {
    return error;
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "ThrottlingException" || name === "ServiceQuotaExceededException") {
    return new ChatRequestError(429, "busy", "AIコーチが混み合っています。少し待ってからもう一度送信してください。");
  }
  if (name === "ConflictException") {
    return new ChatRequestError(409, "busy", "前のメッセージを処理中です。応答が終わってからもう一度送信してください。");
  }
  if (name === "AbortError" || name === "TimeoutError") {
    return new ChatRequestError(504, "timeout", "AIコーチの応答に時間がかかりすぎました。もう一度送信してください。");
  }
  return new ChatRequestError(500, "internal", "AIコーチに接続できませんでした。もう一度送信してください。");
}
