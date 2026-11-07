import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppState } from './AppState';
import { AiChatError, describeTool, isAiChatConfigured, streamAiChat } from './api/aiChatApi';
import { useAuth } from './AuthState';

type AiChatStreamValue = {
  /** The assistant message currently being written, or null when idle. */
  streamingMessageId: string | null;
  /** A short label for the tool the coach is using, if any. */
  activity: string | undefined;
  /** A reply finished while the chat page was not open, and it has not been opened since. */
  hasUnreadReply: boolean;
  send: (text: string) => Promise<void>;
  stop: () => void;
};

const UNREAD_STORAGE_KEY = 'kintrain.aiChat.hasUnreadReply';

function readStoredUnread(): boolean {
  try {
    return window.localStorage.getItem(UNREAD_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function storeUnread(value: boolean): void {
  try {
    if (value) {
      window.localStorage.setItem(UNREAD_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(UNREAD_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable (private browsing); the badge then lasts for this visit only.
  }
}

const AiChatStreamContext = createContext<AiChatStreamValue | null>(null);

/**
 * Owns the in-flight AI chat reply above the router, so moving to another page while the
 * coach is answering does not cancel the request. The reply keeps streaming into the chat
 * history and is there when the chat page is opened again. A reply that finishes while the
 * chat page is closed is marked unread until the page is opened.
 */
export function AiChatStreamProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const { data, appendUserMessage, createAssistantMessage, appendAssistantChunk, finalizeAssistantMessage, setAssistantMessageError } =
    useAppState();
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const isChatPageOpen = useLocation().pathname.startsWith('/ai-chat');
  const isChatPageOpenRef = useRef(isChatPageOpen);
  isChatPageOpenRef.current = isChatPageOpen;
  const [hasUnreadReply, setHasUnreadReply] = useState(readStoredUnread);

  useEffect(() => {
    if (isChatPageOpen) {
      setHasUnreadReply(false);
    }
  }, [isChatPageOpen]);

  useEffect(() => {
    storeUnread(hasUnreadReply);
  }, [hasUnreadReply]);

  // The request needs the latest profile and session, but send itself should stay stable.
  const latest = useRef({ data, appendUserMessage, createAssistantMessage, appendAssistantChunk, finalizeAssistantMessage, setAssistantMessageError });
  latest.current = { data, appendUserMessage, createAssistantMessage, appendAssistantChunk, finalizeAssistantMessage, setAssistantMessageError };

  const send = useCallback(
    async (text: string) => {
      if (!text || abortRef.current || !isAuthenticated) {
        return;
      }
      const app = latest.current;
      const session = app.data.aiChatSessions.find((s) => s.id === app.data.activeAiChatSessionId) ?? app.data.aiChatSessions[0];
      app.appendUserMessage(text);
      const messageId = app.createAssistantMessage();
      const controller = new AbortController();
      abortRef.current = controller;
      setStreamingMessageId(messageId);
      setActivity(undefined);
      let wasStopped = false;

      try {
        if (!isAiChatConfigured()) {
          throw new AiChatError('not_configured', 'AIコーチは現在利用できません。', false);
        }
        await streamAiChat(
          {
            sessionId: session.id,
            message: text,
            userProfile: app.data.userProfile,
            aiCharacterProfile: app.data.aiCharacterProfile
          },
          (event) => {
            if (event.type === 'tool') {
              setActivity(describeTool(event.name));
            } else if (event.type === 'delta') {
              setActivity(undefined);
              latest.current.appendAssistantChunk(messageId, event.text);
            }
          },
          controller.signal
        );
      } catch (error) {
        const chatError =
          error instanceof AiChatError
            ? error
            : new AiChatError('internal', 'AIコーチの応答中にエラーが発生しました。もう一度送信してください。', true);
        wasStopped = chatError.code === 'aborted';
        if (!wasStopped) {
          latest.current.setAssistantMessageError(messageId, { message: chatError.message, retryable: chatError.retryable });
        }
      } finally {
        latest.current.finalizeAssistantMessage(messageId);
        // An error is also news the person has not seen yet.
        if (!wasStopped && !isChatPageOpenRef.current) {
          setHasUnreadReply(true);
        }
        abortRef.current = null;
        setStreamingMessageId(null);
        setActivity(undefined);
      }
    },
    [isAuthenticated]
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // Signing out ends the reply and clears the unread mark; nothing else does. While the
  // session is still being restored on startup, nobody has signed out yet.
  useEffect(() => {
    if (!isAuthenticated && !isAuthLoading) {
      abortRef.current?.abort();
      setHasUnreadReply(false);
    }
  }, [isAuthenticated, isAuthLoading]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const value = useMemo(
    () => ({ streamingMessageId, activity, hasUnreadReply, send, stop }),
    [streamingMessageId, activity, hasUnreadReply, send, stop]
  );
  return <AiChatStreamContext.Provider value={value}>{children}</AiChatStreamContext.Provider>;
}

export function useAiChatStream(): AiChatStreamValue {
  const value = useContext(AiChatStreamContext);
  if (!value) {
    throw new Error('useAiChatStream must be used within AiChatStreamProvider');
  }
  return value;
}
