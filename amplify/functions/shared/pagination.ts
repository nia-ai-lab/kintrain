type PageTokenPayload = {
  version: 1;
  context: string;
  key: Record<string, unknown>;
};

export function encodePageToken(
  lastEvaluatedKey: Record<string, unknown> | undefined,
  context: string
): string | undefined {
  if (!lastEvaluatedKey) {
    return undefined;
  }
  const payload: PageTokenPayload = {
    version: 1,
    context,
    key: lastEvaluatedKey
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodePageToken(
  value: string | undefined,
  expectedContext: string,
  expectedUserId: string
): Record<string, unknown> | undefined | null {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PageTokenPayload>;
    if (
      parsed.version !== 1 ||
      parsed.context !== expectedContext ||
      !parsed.key ||
      typeof parsed.key !== "object" ||
      Array.isArray(parsed.key) ||
      parsed.key.userId !== expectedUserId
    ) {
      return null;
    }
    return parsed.key;
  } catch {
    return null;
  }
}
