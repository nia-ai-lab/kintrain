import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../AppState';
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

export function AiChatPage() {
  const {
    data,
    appendUserMessage,
    createAssistantMessage,
    appendAssistantChunk,
    finalizeAssistantMessage
  } = useAppState();

  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const session = useMemo(
    () => data.aiChatSessions.find((s) => s.id === data.activeAiChatSessionId) ?? data.aiChatSessions[0],
    [data.aiChatSessions, data.activeAiChatSessionId]
  );

  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!listRef.current) {
      return;
    }
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [session.messages.length, isStreaming]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) {
      return;
    }

    setInput('');
    appendUserMessage(text);

    const messageId = createAssistantMessage();
    const full = buildMockAdvice(text, data.aiCharacterProfile.tonePreset);
    const chunks = full.match(/.{1,18}/g) ?? [full];

    setIsStreaming(true);
    let cursor = 0;
    const timer = window.setInterval(() => {
      appendAssistantChunk(messageId, chunks[cursor]);
      cursor += 1;
      if (cursor >= chunks.length) {
        window.clearInterval(timer);
        finalizeAssistantMessage(messageId);
        setIsStreaming(false);
      }
    }, 80);
  }

  const avatar = data.aiCharacterProfile.avatarImageUrl;

  return (
    <div className="stack-lg">
      <section className="card chat-header-card">
        <div className="row-between align-start">
          <div className="chat-agent-head">
            <img src={avatar} alt={data.aiCharacterProfile.characterName} className="avatar-large" />
            <div>
              <p className="eyebrow">AI コーチ</p>
              <h1>{data.aiCharacterProfile.characterName}</h1>
            </div>
          </div>
        </div>
      </section>

      <section className="chat-body card" ref={listRef}>
        {session.messages.map((message) => {
          const isAssistant = message.role === 'assistant';
          const messageAvatar = data.aiCharacterProfile.avatarImageUrl;

          return (
            <div key={message.id} className={isAssistant ? 'message-row assistant' : 'message-row user'}>
              {isAssistant && <img src={messageAvatar} alt="ai" className="avatar-small" />}
              <div className={isAssistant ? 'message-bubble assistant' : 'message-bubble user'}>
                {isAssistant && <p className="message-name">{data.aiCharacterProfile.characterName}</p>}
                <p>{message.content || (isStreaming ? '...' : '')}</p>
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
        <div className="row-between">
          <p className="muted">{isStreaming ? '応答中...' : '送信ボタンでメッセージを送信'}</p>
          <button className="btn primary" type="submit" disabled={isStreaming || !input.trim()}>
            送信
          </button>
        </div>
      </form>
    </div>
  );
}
