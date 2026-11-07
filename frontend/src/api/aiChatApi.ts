import { fetchAuthSession } from 'aws-amplify/auth';
import amplifyOutputs from '../amplify_outputs.json';
import type { AiCharacterProfile, UserProfile } from '../types';

type AiChatEndpointOutput = {
  custom?: {
    endpoints?: {
      aiChatApiEndpoint?: string;
    };
  };
};

export type AiChatEvent =
  | { type: 'thinking' }
  | { type: 'tool'; name: string }
  | { type: 'delta'; text: string }
  | { type: 'done' };

export type AiChatErrorCode =
  | 'not_configured'
  | 'unauthorized'
  | 'invalid_request'
  | 'busy'
  | 'timeout'
  | 'network'
  | 'interrupted'
  | 'aborted'
  | 'internal';

export class AiChatError extends Error {
  constructor(
    readonly code: AiChatErrorCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'AiChatError';
  }
}

export type StreamAiChatInput = {
  sessionId: string;
  message: string;
  userProfile: UserProfile;
  aiCharacterProfile: AiCharacterProfile;
};

const chatEndpoint = (() => {
  const base = ((amplifyOutputs as AiChatEndpointOutput).custom?.endpoints?.aiChatApiEndpoint ?? '').trim();
  return base ? `${base.replace(/\/+$/, '')}/chat` : '';
})();

// The server sends a keep-alive every 15 seconds, so this much silence means the connection is gone.
const IDLE_TIMEOUT_MS = 60_000;

const retryableCodes = new Set<AiChatErrorCode>(['busy', 'timeout', 'network', 'interrupted', 'internal']);

export function isAiChatConfigured(): boolean {
  return chatEndpoint.length > 0;
}

function errorFor(code: string | undefined, message: string | undefined): AiChatError {
  const knownCode = (code ?? 'internal') as AiChatErrorCode;
  return new AiChatError(
    knownCode,
    message || 'AIコーチの応答中にエラーが発生しました。もう一度送信してください。',
    retryableCodes.has(knownCode)
  );
}

async function readErrorResponse(response: Response): Promise<AiChatError> {
  if (response.status === 401 || response.status === 403) {
    return new AiChatError('unauthorized', 'ログインの有効期限が切れました。ページを再読み込みしてください。', false);
  }
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (response.status === 429 && !body?.message) {
    return new AiChatError('busy', 'リクエストが集中しています。少し待ってからもう一度送信してください。', true);
  }
  return errorFor(body?.code, body?.message);
}

function dispatchFrame(frame: string, onEvent: (event: AiChatEvent) => void): 'done' | null {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    // Lines starting with ":" are SSE comments (connection and keep-alive markers).
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
  } catch {
    return null;
  }

  switch (payload.event) {
    case 'status':
      onEvent({ type: 'thinking' });
      return null;
    case 'tool':
      if (typeof payload.name === 'string') {
        onEvent({ type: 'tool', name: payload.name });
      }
      return null;
    case 'delta':
      if (typeof payload.text === 'string' && payload.text) {
        onEvent({ type: 'delta', text: payload.text });
      }
      return null;
    case 'error':
      throw errorFor(
        typeof payload.code === 'string' ? payload.code : undefined,
        typeof payload.message === 'string' ? payload.message : undefined
      );
    case 'done':
      onEvent({ type: 'done' });
      return 'done';
    default:
      return null;
  }
}

/**
 * Sends one message to the AI coach through the AI chat API and streams the reply.
 * Resolves when the reply is complete; rejects with an AiChatError otherwise.
 */
export async function streamAiChat(
  input: StreamAiChatInput,
  onEvent: (event: AiChatEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!chatEndpoint) {
    throw new AiChatError('not_configured', 'AIコーチは現在利用できません。', false);
  }

  const session = await fetchAuthSession();
  const accessToken = session.tokens?.accessToken?.toString();
  if (!accessToken) {
    throw new AiChatError('unauthorized', 'ログインの有効期限が切れました。ページを再読み込みしてください。', false);
  }

  const controller = new AbortController();
  let abortReason: 'user' | 'idle' | null = null;
  const onUserAbort = () => {
    abortReason = 'user';
    controller.abort();
  };
  signal?.addEventListener('abort', onUserAbort, { once: true });
  let idleTimer = window.setTimeout(() => undefined, 0);
  const resetIdleTimer = () => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      abortReason = 'idle';
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };

  try {
    resetIdleTimer();
    let response: Response;
    try {
      response = await fetch(chatEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          sessionId: input.sessionId,
          message: input.message,
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
        }),
        signal: controller.signal
      });
    } catch (error) {
      throw toTransportError(error, abortReason);
    }

    if (!response.ok) {
      throw await readErrorResponse(response);
    }
    if (!response.body) {
      throw new AiChatError('internal', 'AIコーチから応答がありませんでした。もう一度送信してください。', true);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw toTransportError(error, abortReason);
        }
        resetIdleTimer();
        buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');

        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (dispatchFrame(frame, onEvent) === 'done') {
            return;
          }
          boundary = buffer.indexOf('\n\n');
        }

        if (chunk.done) {
          if (buffer.trim() && dispatchFrame(buffer, onEvent) === 'done') {
            return;
          }
          throw new AiChatError('interrupted', '応答が途中で途切れました。もう一度送信してください。', true);
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  } finally {
    window.clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onUserAbort);
  }
}

function toTransportError(error: unknown, abortReason: 'user' | 'idle' | null): AiChatError {
  if (error instanceof AiChatError) {
    return error;
  }
  if (abortReason === 'user') {
    return new AiChatError('aborted', '応答を停止しました。', true);
  }
  if (abortReason === 'idle') {
    return new AiChatError('timeout', 'AIコーチからの応答が止まりました。もう一度送信してください。', true);
  }
  return new AiChatError('network', '通信できませんでした。電波の良い場所でもう一度送信してください。', true);
}

const toolLabels: Array<[RegExp, string]> = [
  [/^WebSearch$/i, 'Webで調べています'],
  [/agentcore_search/, '使う機能を探しています'],
  [/coaching_context|coaching_note/, 'コーチング方針を確認しています'],
  [/^save_/, '記録を保存しています'],
  [/daily_record|daily_readiness/, 'Dailyの記録を確認しています'],
  [/gym_visits|training_history|coaching_summary/, 'トレーニング履歴を確認しています'],
  [/training_plan/, '予定を確認しています'],
  [/create_temporary|update_temporary|reschedule|cancel_temporary/, 'メニューを更新しています'],
  [/menu/, 'メニューを確認しています'],
  [/goal/, '目標を確認しています'],
  [/analysis_export/, 'データを集計しています']
];

/** A short Japanese label for a tool the coach is using. Gateway tool names carry a "target___" prefix. */
export function describeTool(name: string): string {
  const bare = name.includes('___') ? name.slice(name.lastIndexOf('___') + 3) : name;
  return toolLabels.find(([pattern]) => pattern.test(bare))?.[1] ?? '情報を確認しています';
}
