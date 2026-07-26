import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createHmac, timingSafeEqual } from "node:crypto";

type PageTokenPayload = {
  version: 2;
  cursor: Record<string, string | number>;
};

const paginationSecretArn = process.env.PAGINATION_TOKEN_SECRET_ARN ?? "";
const maxPageTokenLength = 4096;
const secretsManager = new SecretsManagerClient({
  region: process.env.AWS_REGION
});

let cachedSigningSecret: Promise<string> | undefined;

async function loadSigningSecret(): Promise<string> {
  if (!paginationSecretArn) {
    throw new Error("Pagination token signing secret is not configured.");
  }

  cachedSigningSecret ??= secretsManager
    .send(
      new GetSecretValueCommand({
        SecretId: paginationSecretArn
      })
    )
    .then((result) => {
      const value =
        result.SecretString ??
        (result.SecretBinary ? Buffer.from(result.SecretBinary).toString("utf8") : "");
      if (value.length < 32) {
        throw new Error("Pagination token signing secret is invalid.");
      }
      return value;
    })
    .catch((error: unknown) => {
      cachedSigningSecret = undefined;
      throw error;
    });

  return cachedSigningSecret;
}

async function resolveSigningSecret(signingSecret?: string): Promise<string> {
  const value = signingSecret ?? (await loadSigningSecret());
  if (value.length < 32) {
    throw new Error("Pagination token signing secret is invalid.");
  }
  return value;
}

function pageTokenSignature(
  encodedPayload: string,
  context: string,
  userId: string,
  signingSecret: string
): Buffer {
  const signedContext = JSON.stringify({
    userId,
    context,
    payload: encodedPayload
  });
  return createHmac("sha256", signingSecret).update(signedContext, "utf8").digest();
}

function cursorWithoutUserId(
  lastEvaluatedKey: Record<string, unknown>,
  expectedUserId: string
): Record<string, string | number> {
  if (lastEvaluatedKey.userId !== expectedUserId) {
    throw new Error("Pagination cursor does not belong to the authenticated user.");
  }

  const cursor: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(lastEvaluatedKey)) {
    if (name === "userId") {
      continue;
    }
    if (
      (typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw new Error("Pagination cursor contains an unsupported value.");
    }
    cursor[name] = value;
  }
  if (Object.keys(cursor).length === 0) {
    throw new Error("Pagination cursor is empty.");
  }
  return cursor;
}

function isPageCursor(value: unknown): value is Record<string, string | number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    !Object.hasOwn(value, "userId") &&
    entries.every(
      ([, item]) =>
        (typeof item === "string" || typeof item === "number") &&
        (typeof item !== "number" || Number.isFinite(item))
    )
  );
}

export async function encodePageToken(
  lastEvaluatedKey: Record<string, unknown> | undefined,
  context: string,
  userId: string,
  signingSecret?: string
): Promise<string | undefined> {
  if (!lastEvaluatedKey) {
    return undefined;
  }

  const secret = await resolveSigningSecret(signingSecret);
  const payload: PageTokenPayload = {
    version: 2,
    cursor: cursorWithoutUserId(lastEvaluatedKey, userId)
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = pageTokenSignature(encodedPayload, context, userId, secret).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

export async function decodePageToken(
  value: string | undefined,
  expectedContext: string,
  expectedUserId: string,
  signingSecret?: string
): Promise<Record<string, unknown> | undefined | null> {
  if (!value) {
    return undefined;
  }
  if (value.length > maxPageTokenLength) {
    return null;
  }

  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  const secret = await resolveSigningSecret(signingSecret);
  try {
    const actualSignature = Buffer.from(parts[1], "base64url");
    const expectedSignature = pageTokenSignature(parts[0], expectedContext, expectedUserId, secret);
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      return null;
    }

    const parsed = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8")
    ) as Partial<PageTokenPayload>;
    if (parsed.version !== 2 || !isPageCursor(parsed.cursor)) {
      return null;
    }
    return {
      ...parsed.cursor,
      userId: expectedUserId
    };
  } catch {
    return null;
  }
}
