import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

export function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function normalizePath(event: APIGatewayProxyEvent): string {
  const stage = event.requestContext.stage;
  if (stage && stage !== "$default" && event.path.startsWith(`/${stage}/`)) {
    return event.path.slice(stage.length + 1);
  }
  return event.path;
}

export function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

export function parseBody<T>(event: APIGatewayProxyEvent): T | null {
  if (!event.body) {
    return null;
  }
  try {
    return JSON.parse(event.body) as T;
  } catch {
    return null;
  }
}

export function getUserId(event: APIGatewayProxyEvent): string | null {
  const authorizer = event.requestContext.authorizer as
    | { claims?: Record<string, string> }
    | undefined;
  const claims = authorizer?.claims ?? {};
  return claims.sub ?? null;
}

export function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function parseYmd(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

export function toMonthRange(month: string): { fromDate: string; toDate: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return null;
  }
  const [y, m] = month.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    return null;
  }

  const start = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(y, m, 0));
  const end = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${endDate
    .getUTCDate()
    .toString()
    .padStart(2, "0")}`;
  return { fromDate: start, toDate: end };
}
