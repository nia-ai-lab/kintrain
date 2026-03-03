import { fetchAuthSession } from "aws-amplify/auth";
import amplifyOutputs from "../amplify_outputs.json";
import type { AiCharacterProfile, UserProfile } from "../types";

type RuntimeEndpointOutput = {
  auth?: {
    aws_region?: string;
  };
  custom?: {
    endpoints?: {
      aiRuntimeEndpoint?: string;
      aiRuntimeEndpointArn?: string;
    };
  };
};

export type AiRuntimeStreamEvent =
  | {
      type: "status";
      status: string;
      message: string;
    }
  | {
      type: "chunk";
      chunk: string;
    }
  | {
      type: "done";
      runtimeSessionId?: string;
    };

export type InvokeAiRuntimeInput = {
  aiChatSessionId: string;
  runtimeSessionId?: string;
  userMessage: string;
  userProfile: UserProfile;
  aiCharacterProfile: AiCharacterProfile;
};

type RuntimeInvokeConfig = {
  invokeUrl: string;
  baseEndpoint?: string;
  runtimeArn?: string;
  qualifier?: string;
};

function resolveRuntimeInvokeConfig(): RuntimeInvokeConfig | null {
  const output = amplifyOutputs as RuntimeEndpointOutput;
  const aiRuntimeEndpoint = (output.custom?.endpoints?.aiRuntimeEndpoint ?? "").trim();
  if (aiRuntimeEndpoint.length > 0) {
    const endpoint = aiRuntimeEndpoint.replace(/\/+$/, "");
    return {
      invokeUrl: `${endpoint}/invocations`,
      baseEndpoint: endpoint
    };
  }

  const runtimeEndpointArn = (output.custom?.endpoints?.aiRuntimeEndpointArn ?? "").trim();
  const region = output.auth?.aws_region;
  if (!runtimeEndpointArn || !region) {
    return null;
  }

  const endpointToken = "/runtime-endpoint/";
  const splitIndex = runtimeEndpointArn.indexOf(endpointToken);
  const runtimeArn = splitIndex >= 0 ? runtimeEndpointArn.slice(0, splitIndex) : runtimeEndpointArn;
  const qualifier = splitIndex >= 0 ? runtimeEndpointArn.slice(splitIndex + endpointToken.length) : "DEFAULT";
  if (!runtimeArn) {
    return null;
  }

  const encodedRuntimeArn = encodeURIComponent(runtimeArn);
  const encodedQualifier = encodeURIComponent(qualifier || "DEFAULT");
  const baseEndpoint = `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodedRuntimeArn}`;
  return {
    invokeUrl: `${baseEndpoint}/invocations?qualifier=${encodedQualifier}`,
    baseEndpoint,
    runtimeArn,
    qualifier
  };
}

const runtimeInvokeConfig = resolveRuntimeInvokeConfig();

function getAiRuntimeAccessToken(session: Awaited<ReturnType<typeof fetchAuthSession>>): string {
  const token = session.tokens?.accessToken?.toString();
  if (!token) {
    throw new Error("Cognito access token is not available.");
  }
  return token;
}

export function isAiRuntimeConfigured(): boolean {
  return runtimeInvokeConfig !== null;
}

function parseSseEvent(raw: string): { eventName: string; data: string } | null {
  const lines = raw.split(/\r?\n/);
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    eventName,
    data: dataLines.join("\n")
  };
}

function extractSseFrame(buffer: string): { frame: string; rest: string } | null {
  const lfBoundaryIndex = buffer.indexOf("\n\n");
  const crlfBoundaryIndex = buffer.indexOf("\r\n\r\n");

  if (lfBoundaryIndex < 0 && crlfBoundaryIndex < 0) {
    return null;
  }

  if (lfBoundaryIndex >= 0 && (crlfBoundaryIndex < 0 || lfBoundaryIndex < crlfBoundaryIndex)) {
    return {
      frame: buffer.slice(0, lfBoundaryIndex),
      rest: buffer.slice(lfBoundaryIndex + 2)
    };
  }

  return {
    frame: buffer.slice(0, crlfBoundaryIndex),
    rest: buffer.slice(crlfBoundaryIndex + 4)
  };
}

function toStatusEvent(eventName: string, payload: unknown): AiRuntimeStreamEvent | null {
  const knownStatusEvents = new Set(["status", "thinking", "tool_calling", "tool_succeeded", "tool_failed"]);
  if (!knownStatusEvents.has(eventName)) {
    return null;
  }

  if (typeof payload === "string") {
    return {
      type: "status",
      status: eventName,
      message: payload
    };
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const status = typeof record.status === "string" ? record.status : eventName;
    const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
    return {
      type: "status",
      status,
      message
    };
  }

  return {
    type: "status",
    status: eventName,
    message: ""
  };
}

function toChunkEvent(eventName: string, payload: unknown): AiRuntimeStreamEvent | null {
  if (typeof payload === "string") {
    if (eventName === "done") {
      return {
        type: "done"
      };
    }
    return {
      type: "chunk",
      chunk: payload
    };
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (eventName === "done") {
    return {
      type: "done",
      runtimeSessionId: typeof record.runtimeSessionId === "string" ? record.runtimeSessionId : undefined
    };
  }

  const chunkCandidate =
    (typeof record.chunk === "string" && record.chunk) ||
    (typeof record.text === "string" && record.text) ||
    (typeof record.delta === "string" && record.delta) ||
    (typeof record.content === "string" && record.content);

  if (chunkCandidate) {
    return {
      type: "chunk",
      chunk: chunkCandidate
    };
  }

  return null;
}

function resolveEventName(eventName: string, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const embeddedEvent = (payload as Record<string, unknown>).event;
    if (typeof embeddedEvent === "string" && embeddedEvent.trim().length > 0) {
      return embeddedEvent.trim();
    }
  }
  return eventName;
}

export async function invokeAiRuntimeStream(
  input: InvokeAiRuntimeInput,
  onEvent: (event: AiRuntimeStreamEvent) => void
): Promise<{ runtimeSessionId?: string }> {
  if (!runtimeInvokeConfig) {
    throw new Error("AI runtime endpoint is not configured.");
  }

  const session = await fetchAuthSession();
  const accessToken = getAiRuntimeAccessToken(session);
  const response = await fetch(runtimeInvokeConfig.invokeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Accept: "text/event-stream",
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      inputText: input.userMessage,
      sessionId: input.runtimeSessionId,
      metadata: {
        aiChatSessionId: input.aiChatSessionId,
        userProfile: {
          userName: input.userProfile.userName,
          sex: input.userProfile.sex,
          birthDate: input.userProfile.birthDate,
          heightCm: input.userProfile.heightCm,
          timeZoneId: input.userProfile.timeZoneId
        },
        aiCharacterProfile: {
          characterName: input.aiCharacterProfile.characterName,
          tonePreset: input.aiCharacterProfile.tonePreset,
          characterDescription: input.aiCharacterProfile.characterDescription,
          speechEnding: input.aiCharacterProfile.speechEnding
        }
      }
    })
  });

  if (!response.ok || !response.body) {
    throw new Error(`AI runtime request failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalRuntimeSessionId: string | undefined;
  let receivedDoneEvent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
    } else {
      buffer += decoder.decode(value, { stream: true });
    }

    while (true) {
      const frame = extractSseFrame(buffer);
      if (!frame) {
        break;
      }
      buffer = frame.rest;
      const parsed = parseSseEvent(frame.frame);
      if (!parsed) {
        continue;
      }

      let payload: unknown = parsed.data;
      try {
        payload = JSON.parse(parsed.data);
      } catch {
        // Keep raw text payload.
      }
      const resolvedEventName = resolveEventName(parsed.eventName, payload);

      const statusEvent = toStatusEvent(resolvedEventName, payload);
      if (statusEvent) {
        onEvent(statusEvent);
        continue;
      }

      const chunkEvent = toChunkEvent(resolvedEventName, payload);
      if (chunkEvent) {
        if (chunkEvent.type === "done" && chunkEvent.runtimeSessionId) {
          finalRuntimeSessionId = chunkEvent.runtimeSessionId;
        }
        onEvent(chunkEvent);
        if (chunkEvent.type === "done") {
          receivedDoneEvent = true;
          break;
        }
      }
    }

    if (receivedDoneEvent) {
      break;
    }

    if (done) {
      const tail = parseSseEvent(buffer.trim());
      if (tail) {
        let payload: unknown = tail.data;
        try {
          payload = JSON.parse(tail.data);
        } catch {
          // Keep raw text payload.
        }
        const resolvedEventName = resolveEventName(tail.eventName, payload);

        const statusEvent = toStatusEvent(resolvedEventName, payload);
        if (statusEvent) {
          onEvent(statusEvent);
        } else {
          const chunkEvent = toChunkEvent(resolvedEventName, payload);
          if (chunkEvent) {
            if (chunkEvent.type === "done" && chunkEvent.runtimeSessionId) {
              finalRuntimeSessionId = chunkEvent.runtimeSessionId;
            }
            onEvent(chunkEvent);
            if (chunkEvent.type === "done") {
              receivedDoneEvent = true;
            }
          }
        }
      }
      break;
    }
  }

  if (receivedDoneEvent) {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors; stream is effectively complete for the UI.
    }
  } else {
    onEvent({
      type: "done",
      runtimeSessionId: finalRuntimeSessionId
    });
  }

  return {
    runtimeSessionId: finalRuntimeSessionId
  };
}
