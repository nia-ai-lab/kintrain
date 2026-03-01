import { fetchAuthSession } from "aws-amplify/auth";
import amplifyOutputs from "../amplify_outputs.json";

type RuntimeEndpointOutput = {
  custom?: {
    endpoints?: {
      aiRuntimeEndpoint?: string;
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
  timeZoneId: string;
  characterName: string;
};

const aiRuntimeEndpoint =
  ((amplifyOutputs as RuntimeEndpointOutput).custom?.endpoints?.aiRuntimeEndpoint ?? "").replace(/\/+$/, "");

function getAiRuntimeAccessToken(session: Awaited<ReturnType<typeof fetchAuthSession>>): string {
  const token = session.tokens?.accessToken?.toString();
  if (!token) {
    throw new Error("Cognito access token is not available.");
  }
  return token;
}

export function isAiRuntimeConfigured(): boolean {
  return aiRuntimeEndpoint.length > 0;
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

export async function invokeAiRuntimeStream(
  input: InvokeAiRuntimeInput,
  onEvent: (event: AiRuntimeStreamEvent) => void
): Promise<{ runtimeSessionId?: string }> {
  if (!aiRuntimeEndpoint) {
    throw new Error("AI runtime endpoint is not configured.");
  }

  const session = await fetchAuthSession();
  const accessToken = getAiRuntimeAccessToken(session);
  const response = await fetch(`${aiRuntimeEndpoint}/invocations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      inputText: input.userMessage,
      sessionId: input.runtimeSessionId,
      metadata: {
        aiChatSessionId: input.aiChatSessionId,
        timeZoneId: input.timeZoneId,
        characterName: input.characterName
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const boundaryIndex = buffer.indexOf("\n\n");
      if (boundaryIndex < 0) {
        break;
      }
      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);

      const parsed = parseSseEvent(rawEvent);
      if (!parsed) {
        continue;
      }

      let payload: unknown = parsed.data;
      try {
        payload = JSON.parse(parsed.data);
      } catch {
        // Keep raw text payload.
      }

      const statusEvent = toStatusEvent(parsed.eventName, payload);
      if (statusEvent) {
        onEvent(statusEvent);
        continue;
      }

      const chunkEvent = toChunkEvent(parsed.eventName, payload);
      if (chunkEvent) {
        if (chunkEvent.type === "done" && chunkEvent.runtimeSessionId) {
          finalRuntimeSessionId = chunkEvent.runtimeSessionId;
        }
        onEvent(chunkEvent);
      }
    }
  }

  onEvent({
    type: "done",
    runtimeSessionId: finalRuntimeSessionId
  });

  return {
    runtimeSessionId: finalRuntimeSessionId
  };
}
