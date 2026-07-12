import { CognitoJwtVerifier } from "aws-jwt-verify";

type JsonObject = Record<string, unknown>;

type McpInterceptorEvent = {
  interceptorInputVersion?: string;
  mcp?: {
    gatewayRequest?: {
      headers?: Record<string, string>;
      body?: unknown;
    };
  };
};

type VerifiedIdentity = {
  sub: string;
};

type VerifyAccessToken = (token: string) => Promise<VerifiedIdentity>;

const requiredScope = "aws.cognito.signin.user.admin";
const trustedPrincipalArgument = "__principalUserId";
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function extractBearerToken(authorization: string | undefined): string | null {
  const value = authorization?.trim() ?? "";
  if (!value.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = value.slice(7).trim();
  return token || null;
}

function gatewayRequestOutput(body: JsonObject): JsonObject {
  return {
    interceptorOutputVersion: "1.0",
    mcp: {
      transformedGatewayRequest: {
        body
      }
    }
  };
}

function gatewayErrorOutput(body: JsonObject | null, statusCode: number, message: string): JsonObject {
  return {
    interceptorOutputVersion: "1.0",
    mcp: {
      transformedGatewayResponse: {
        statusCode,
        body: {
          jsonrpc: "2.0",
          id: body?.id ?? null,
          error: {
            code: statusCode === 401 ? -32001 : -32003,
            message
          }
        }
      }
    }
  };
}

async function verifyCognitoAccessToken(token: string): Promise<VerifiedIdentity> {
  const userPoolId = process.env.USER_POOL_ID?.trim();
  const userPoolClientId = process.env.USER_POOL_CLIENT_ID?.trim();
  if (!userPoolId || !userPoolClientId) {
    throw new Error("JWT verifier environment is not configured.");
  }

  verifier ??= CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: "access",
    clientId: userPoolClientId
  });

  const payload = await verifier.verify(token);
  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
  if (!scopes.includes(requiredScope)) {
    throw new Error("Required scope is missing.");
  }
  if (typeof payload.sub !== "string" || !payload.sub.trim()) {
    throw new Error("JWT sub is missing.");
  }
  return { sub: payload.sub.trim() };
}

function identityArgumentConflicts(argumentsObject: JsonObject, principalUserId: string): boolean {
  if (Object.prototype.hasOwnProperty.call(argumentsObject, trustedPrincipalArgument)) {
    return true;
  }

  for (const key of ["userId", "actorId"]) {
    if (!Object.prototype.hasOwnProperty.call(argumentsObject, key)) {
      continue;
    }
    const value = argumentsObject[key];
    if (typeof value !== "string" || value.trim() !== principalUserId) {
      return true;
    }
  }
  return false;
}

export async function processInterceptorEvent(
  event: McpInterceptorEvent,
  verifyAccessToken: VerifyAccessToken = verifyCognitoAccessToken
): Promise<JsonObject> {
  const body = asObject(event.mcp?.gatewayRequest?.body);
  if (!body) {
    return gatewayErrorOutput(null, 400, "Invalid MCP request.");
  }

  if (body.method !== "tools/call") {
    return gatewayRequestOutput(body);
  }

  const token = extractBearerToken(getHeader(event.mcp?.gatewayRequest?.headers, "Authorization"));
  if (!token) {
    return gatewayErrorOutput(body, 401, "Unauthorized.");
  }

  let identity: VerifiedIdentity;
  try {
    identity = await verifyAccessToken(token);
  } catch {
    return gatewayErrorOutput(body, 401, "Unauthorized.");
  }

  const params = asObject(body.params);
  const inputArguments = asObject(params?.arguments) ?? {};
  if (identityArgumentConflicts(inputArguments, identity.sub)) {
    return gatewayErrorOutput(body, 403, "Forbidden.");
  }

  const transformedArguments: JsonObject = { ...inputArguments };
  delete transformedArguments.userId;
  delete transformedArguments.actorId;
  delete transformedArguments[trustedPrincipalArgument];
  transformedArguments[trustedPrincipalArgument] = identity.sub;

  return gatewayRequestOutput({
    ...body,
    params: {
      ...(params ?? {}),
      arguments: transformedArguments
    }
  });
}

export const handler = async (event: McpInterceptorEvent): Promise<JsonObject> => processInterceptorEvent(event);
