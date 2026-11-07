import { FormEvent, KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { useAppState } from '../AppState';
import { AiChatError, describeTool, isAiChatConfigured, streamAiChat } from '../api/aiChatApi';
import { useAuth } from '../AuthState';
import type { ChatMessage } from '../types';

const MAX_INPUT_LENGTH = 4000;

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function TypingIndicator({ label }: { label?: string }) {
  return (
    <div className="chat-typing" role="status" aria-live="polite">
      <span className="chat-typing-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className={label ? 'chat-typing-label' : 'sr-only'}>{label ?? '応答を作成しています'}</span>
    </div>
  );
}

function prefersEnterToSend(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

export function AiChatPage() {
  const { isAuthenticated } = useAuth();
  const {
    data,
    restartActiveAiChatSession,
    appendUserMessage,
    createAssistantMessage,
    appendAssistantChunk,
    finalizeAssistantMessage,
    setAssistantMessageError,
    removeChatMessage
  } = useAppState();

  const [input, setInput] = useState('');
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | undefined>(undefined);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const session = useMemo(
    () => data.aiChatSessions.find((s) => s.id === data.activeAiChatSessionId) ?? data.aiChatSessions[0],
    [data.aiChatSessions, data.activeAiChatSessionId]
  );
  const isStreaming = streamingMessageId !== null;
  const coachName = data.aiCharacterProfile.characterName || 'AIコーチ';
  const avatar = data.aiCharacterProfile.avatarImageUrl || '/assets/characters/default.png';

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const list = listRef.current;
    if (list) {
      list.scrollTo({ top: list.scrollHeight, behavior });
    }
  }, []);

  useLayoutEffect(() => {
    if (isNearBottom) {
      scrollToBottom();
    }
  }, [session.messages, activity, isNearBottom, scrollToBottom]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useLayoutEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [input]);

  function onScroll() {
    const list = listRef.current;
    if (list) {
      setIsNearBottom(list.scrollHeight - list.scrollTop - list.clientHeight < 80);
    }
  }

  async function send(text: string) {
    if (!text || isStreaming || !isAuthenticated) {
      return;
    }
    appendUserMessage(text);
    const messageId = createAssistantMessage();
    const controller = new AbortController();
    abortRef.current = controller;
    setStreamingMessageId(messageId);
    setActivity(undefined);
    setIsNearBottom(true);

    try {
      if (!isAiChatConfigured()) {
        throw new AiChatError('not_configured', 'AIコーチは現在利用できません。', false);
      }
      await streamAiChat(
        {
          sessionId: session.id,
          message: text,
          userProfile: data.userProfile,
          aiCharacterProfile: data.aiCharacterProfile
        },
        (event) => {
          if (event.type === 'tool') {
            setActivity(describeTool(event.name));
          } else if (event.type === 'delta') {
            setActivity(undefined);
            appendAssistantChunk(messageId, event.text);
          }
        },
        controller.signal
      );
    } catch (error) {
      const chatError =
        error instanceof AiChatError
          ? error
          : new AiChatError('internal', 'AIコーチの応答中にエラーが発生しました。もう一度送信してください。', true);
      if (chatError.code !== 'aborted') {
        setAssistantMessageError(messageId, { message: chatError.message, retryable: chatError.retryable });
      }
    } finally {
      finalizeAssistantMessage(messageId);
      abortRef.current = null;
      setStreamingMessageId(null);
      setActivity(undefined);
    }
  }

  function onSubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = input.trim();
    if (!text) {
      return;
    }
    setInput('');
    void send(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Japanese IME confirms conversions with Enter; never treat that as send.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (prefersEnterToSend()) {
      event.preventDefault();
      onSubmit();
    }
  }

  function onRetry(failedMessage: ChatMessage) {
    const index = session.messages.findIndex((message) => message.id === failedMessage.id);
    const previousUser = [...session.messages.slice(0, index)].reverse().find((message) => message.role === 'user');
    if (!previousUser || isStreaming) {
      return;
    }
    removeChatMessage(failedMessage.id);
    removeChatMessage(previousUser.id);
    void send(previousUser.content);
  }

  function onStartNewChat() {
    if (isStreaming) {
      return;
    }
    setInput('');
    restartActiveAiChatSession();
    inputRef.current?.focus();
  }

  return (
    <div className="coach-chat">
      <header className="chat-header">
        <img src={avatar} alt="" className="chat-header-avatar" aria-hidden="true" />
        <h1 className="chat-header-name">{coachName}</h1>
        <button
          type="button"
          className="chat-icon-button"
          onClick={onStartNewChat}
          disabled={isStreaming || session.messages.length === 0}
          aria-label="新しいチャット"
          title="新しいチャット"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 20h8M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
      </header>

      <div className="chat-thread" ref={listRef} onScroll={onScroll} aria-live="polite">
        {session.messages.length === 0 ? (
          <div className="chat-empty">
            <img src={avatar} alt="" className="chat-empty-avatar" aria-hidden="true" />
            <p className="chat-empty-name">{coachName}</p>
          </div>
        ) : (
          session.messages.map((message) => {
            if (message.role === 'user') {
              return (
                <div key={message.id} className="message-row user">
                  <div className="message-bubble user">{message.content}</div>
                </div>
              );
            }
            const isActive = message.id === streamingMessageId;
            return (
              <div key={message.id} className="message-row assistant">
                <img src={avatar} alt="" className="message-avatar" aria-hidden="true" />
                <div className="message-body">
                  {message.content && (
                    <div className="message-bubble assistant">
                      <MarkdownMessage content={message.content} />
                    </div>
                  )}
                  {isActive && (!message.content || activity) && <TypingIndicator label={activity} />}
                  {message.error && (
                    <div className="chat-error" role="alert">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7.5v5M12 16h.01" />
                      </svg>
                      <span>{message.error.message}</span>
                      {message.error.retryable && (
                        <button type="button" className="chat-retry-button" onClick={() => onRetry(message)} disabled={isStreaming}>
                          再送信
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {!isNearBottom && (
        <button type="button" className="chat-jump-button" onClick={() => scrollToBottom('smooth')} aria-label="最新のメッセージへ移動">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M6 13l6 6 6-6" />
          </svg>
        </button>
      )}

      <form className="chat-composer" onSubmit={onSubmit}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value.slice(0, MAX_INPUT_LENGTH))}
          onKeyDown={onKeyDown}
          placeholder="メッセージ"
          aria-label="メッセージ"
          rows={1}
          enterKeyHint={prefersEnterToSend() ? 'send' : 'enter'}
        />
        {isStreaming ? (
          <button type="button" className="chat-send-button is-stop" onClick={() => abortRef.current?.abort()} aria-label="停止" title="停止">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            className="chat-send-button"
            disabled={!input.trim() || !isAuthenticated}
            aria-label="送信"
            title="送信"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
            </svg>
          </button>
        )}
      </form>
    </div>
  );
}
