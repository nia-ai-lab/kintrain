import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { useAppState } from '../AppState';
import { invokeAiRuntimeStream, isAiRuntimeConfigured } from '../api/aiRuntimeApi';
import { useAuth } from '../AuthState';
import type { TonePreset } from '../types';

function buildMockAdvice(input: string, tone: TonePreset): string {
  const base = [
    '今日の混雑前提なら、優先1〜3を先に押さえる進め方が安定します。',
    '昨日実施部位は負荷を抑え、未実施期間の長い種目を先に入れましょう。',
    '前回値を基準に、余裕があれば +2.5kg または +1回を試してください。',
    '最後はフォーム品質が落ちる前に終了し、Dailyへ体調を残すと次回精度が上がります。'
  ].join(' ');

  if (tone === 'polite') {
    return `ご相談ありがとうございます。${base} 入力内容「${input}」を踏まえ、無理のない範囲で進めてください。`;
  }
  if (tone === 'strict-coach') {
    return `結論です。${base} 「${input}」については、実施可否を30秒以内に判断して次へ進みましょう。`;
  }
  return `了解です。${base} 「${input}」に合わせて、今日は実行優先でいきましょう。`;
}

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

function ymdInTimeZone(timeZoneId: string, dayOffset = 0): string {
  const now = new Date();
  if (dayOffset !== 0) {
    now.setDate(now.getDate() + dayOffset);
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZoneId || 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(now);
  const y = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const m = parts.find((part) => part.type === 'month')?.value ?? '01';
  const d = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

export function AiChatPage() {
  const { isAuthenticated } = useAuth();
  const {
    data,
    refreshDailyRecord,
    restartActiveAiChatSession,
    appendUserMessage,
    createAssistantMessage,
    appendAssistantChunk,
    finalizeAssistantMessage
  } = useAppState();

  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusEvents, setStatusEvents] = useState<Array<{ id: string; status: string; message: string }>>([]);

  const session = useMemo(
    () => data.aiChatSessions.find((s) => s.id === data.activeAiChatSessionId) ?? data.aiChatSessions[0],
    [data.aiChatSessions, data.activeAiChatSessionId]
  );
  const latestAssistantMessageId = useMemo(() => {
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      if (session.messages[index].role === 'assistant') {
        return session.messages[index].id;
      }
    }
    return undefined;
  }, [session.messages]);
  const latestStatusEvent = statusEvents.length > 0 ? statusEvents[statusEvents.length - 1] : undefined;

  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!listRef.current) {
      return;
    }
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [session.messages.length, isStreaming, statusEvents.length]);

  function appendStatus(status: string, message: string) {
    setStatusEvents((prev) => {
      const next = [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          status,
          message
        }
      ];
      return next.slice(-8);
    });
  }

  async function streamMockResponse(messageId: string, inputText: string): Promise<void> {
    appendStatus('status', 'Runtime未接続のためモック応答を使用します。');
    const full = buildMockAdvice(inputText, data.aiCharacterProfile.tonePreset);
    const chunks = full.match(/.{1,18}/g) ?? [full];

    await new Promise<void>((resolve) => {
      let cursor = 0;
      const timer = window.setInterval(() => {
        if (cursor === 0) {
          setStatusEvents([]);
        }
        appendAssistantChunk(messageId, chunks[cursor]);
        cursor += 1;
        if (cursor >= chunks.length) {
          window.clearInterval(timer);
          resolve();
        }
      }, 80);
    });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming || !isAuthenticated) {
      return;
    }

    setInput('');
    appendUserMessage(text);

    const messageId = createAssistantMessage();
    setIsStreaming(true);
    setStatusEvents([]);

    try {
      if (!isAiRuntimeConfigured()) {
        await streamMockResponse(messageId, text);
      } else {
        appendStatus('status', 'AI Runtimeへ接続しています...');
        await invokeAiRuntimeStream(
          {
            runtimeSessionId: session.id,
            userMessage: text,
            userProfile: data.userProfile,
            aiCharacterProfile: data.aiCharacterProfile
          },
          (event) => {
            if (event.type === 'status') {
              appendStatus(event.status, event.message);
              return;
            }
            if (event.type === 'chunk') {
              setStatusEvents([]);
              appendAssistantChunk(messageId, event.chunk);
              return;
            }
            if (event.type === 'done') {
              setStatusEvents([]);
            }
          }
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI Runtimeとの通信に失敗しました。';
      appendStatus('error', message);
      appendAssistantChunk(messageId, `エラー: ${message}`);
    } finally {
      setStatusEvents([]);
      finalizeAssistantMessage(messageId);
      setIsStreaming(false);
      const tz = data.userProfile.timeZoneId || 'Asia/Tokyo';
      void refreshDailyRecord(ymdInTimeZone(tz, 0));
      void refreshDailyRecord(ymdInTimeZone(tz, -1));
    }
  }

  function onStartNewChat() {
    if (isStreaming) {
      return;
    }
    setStatusEvents([]);
    setInput('');
    restartActiveAiChatSession();
  }

  const avatar = data.aiCharacterProfile.avatarImageUrl || '/assets/characters/default.png';

  return (
    <div className="stack-lg chat-page">
      <section className="card chat-header-card chat-header-compact">
        <div className="chat-agent-head">
          <img src={avatar} alt={data.aiCharacterProfile.characterName} className="avatar-medium" />
          <div>
            <p className="eyebrow">AI コーチ</p>
            <h2>{data.aiCharacterProfile.characterName}</h2>
          </div>
        </div>
      </section>

      <section className="chat-body card" ref={listRef}>
        {session.messages.map((message) => {
          const isAssistant = message.role === 'assistant';
          const messageAvatar = data.aiCharacterProfile.avatarImageUrl || '/assets/characters/default.png';
          const showStatusAboveAssistant =
            isStreaming && isAssistant && message.id === latestAssistantMessageId && Boolean(latestStatusEvent);

          return (
            <div key={message.id}>
              {showStatusAboveAssistant &&
                latestStatusEvent && (
                  <div className="chat-status-inline" aria-live="polite">
                    <span className="chat-status-label">Runtime {latestStatusEvent.status}</span>
                    <span className="chat-status-text">{latestStatusEvent.message}</span>
                  </div>
                )}
              <div className={isAssistant ? 'message-row assistant' : 'message-row user'}>
                {isAssistant && <img src={messageAvatar} alt="ai" className="avatar-small" />}
                <div className={isAssistant ? 'message-bubble assistant' : 'message-bubble user'}>
                  {isAssistant && <p className="message-name">{data.aiCharacterProfile.characterName}</p>}
                  {message.content ? (
                    <MarkdownMessage content={message.content} />
                  ) : (
                    <p className="message-markdown-placeholder">{isStreaming ? '...' : ''}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <form className="card chat-input" onSubmit={onSubmit}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="例: 今日ジムが混んでいます。優先順を教えて"
          rows={3}
        />
        <div className="chat-input-actions">
          <button className="btn ghost chat-new-session-button" type="button" onClick={onStartNewChat} disabled={isStreaming}>
            新規チャット
          </button>
          <button
            className="btn primary chat-send-icon-button"
            type="submit"
            disabled={isStreaming || !input.trim() || !isAuthenticated}
            aria-label="送信"
            title="送信"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3.4 11.1 20 4.2c.7-.3 1.4.4 1.1 1.1l-6.9 16.6c-.3.8-1.5.8-1.8 0l-2.2-6-6-2.2c-.8-.3-.8-1.5 0-1.8Z" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
