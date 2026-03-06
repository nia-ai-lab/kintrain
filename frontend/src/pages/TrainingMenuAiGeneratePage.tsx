import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { invokeAiRuntimeStream, isAiRuntimeConfigured } from '../api/aiRuntimeApi';
import { useAppState } from '../AppState';
import { useAuth } from '../AuthState';
import type { ChatMessage } from '../types';
import { toLocalIsoWithOffset } from '../utils/date';

type MenuGenerationPolicy = 'machine-only' | 'machine-plus-free' | 'free-only';
type MenuGenerationGoal = 'muscle-gain' | 'fat-loss' | 'maintain';

type MenuGenerationFormState = {
  policy: MenuGenerationPolicy;
  goal: MenuGenerationGoal;
  daysPerWeek: number;
  gymInput: string;
  freeTextRequest: string;
};

type MenuGenerationSessionState = {
  sessionId: string;
  conditionKey: string;
  messages: ChatMessage[];
};

type StatusEvent = {
  id: string;
  status: string;
  message: string;
};

const STORAGE_KEY = 'kintrain-ai-menu-generation-v1';

const initialFormState: MenuGenerationFormState = {
  policy: 'machine-only',
  goal: 'muscle-gain',
  daysPerWeek: 4,
  gymInput: '',
  freeTextRequest: ''
};

function readStoredSession(): MenuGenerationSessionState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<MenuGenerationSessionState>;
    if (
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.conditionKey !== 'string' ||
      !Array.isArray(parsed.messages)
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      conditionKey: parsed.conditionKey,
      messages: parsed.messages.filter(
        (message): message is ChatMessage =>
          Boolean(
            message &&
              typeof message.id === 'string' &&
              (message.role === 'user' || message.role === 'assistant') &&
              typeof message.content === 'string' &&
              typeof message.createdAtLocal === 'string'
          )
      )
    };
  } catch {
    return null;
  }
}

function persistSession(session: MenuGenerationSessionState | null) {
  if (session === null) {
    sessionStorage.removeItem(STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function makeSessionId(): string {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `menu-generation-session-${uuid}`.slice(0, 120);
}

function messageId(prefix: 'menu-user' | 'menu-ai' | 'menu-status'): string {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `${prefix}-${uuid}`;
}

function normalizeDaysPerWeek(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(7, Math.floor(value)));
}

function buildConditionKey(form: MenuGenerationFormState): string {
  return JSON.stringify({
    policy: form.policy,
    goal: form.goal,
    daysPerWeek: normalizeDaysPerWeek(form.daysPerWeek),
    gymInput: form.gymInput.trim(),
    freeTextRequest: form.freeTextRequest.trim()
  });
}

function buildFixedInstruction(form: MenuGenerationFormState, existingTrainingNames: string[], existingSetNames: string[]): string {
  const policyLabel =
    form.policy === 'machine-only'
      ? 'マシンのみ'
      : form.policy === 'machine-plus-free'
        ? 'マシン + フリーウェイト'
        : 'フリーウェイトのみ';
  const goalLabel =
    form.goal === 'muscle-gain'
      ? '筋肥大'
      : form.goal === 'fat-loss'
        ? '減量'
        : '維持';

  const existingNamesText = existingTrainingNames.length > 0 ? existingTrainingNames.join(' / ') : 'なし';
  const existingSetNamesText = existingSetNames.length > 0 ? existingSetNames.join(' / ') : 'なし';

  return [
    'これは KinTrain のトレーニングメニュー新規作成依頼です。',
    'あなたの仕事は、ユーザー条件に合わせて新しいトレーニングメニューセット案を提案し、ユーザーが明示的に登録を指示した時だけ MCP ツールで登録することです。',
    '重要ルール:',
    '- 既存のトレーニングメニューセットや既存のトレーニングメニューは絶対に更新・削除・上書きしないこと。',
    '- 登録時は必ず新規メニューセット 1 件と、新規トレーニングメニュー項目群を作成すること。',
    '- 登録対象の各トレーニングメニュー項目はすべて isAiGenerated=true として扱うこと。',
    '- ユーザーが「登録して」「この内容で保存して」など明示的に指示するまで、登録ツールを呼び出してはならない。',
    '- 既存メニュー名と重複するトレーニング名は避けること。重複しそうなら、AI生成用として意味の分かる別名にして提案すること。',
    '- ジム設備情報が名称だけで不確かな場合はユーザーに確認すること。確認しても不明なままなら、設備不明前提の仮案を出すこと。',
    '- 提案時は自然文の説明に加えて、登録可能なメニューセット案を分かりやすい Markdown の番号付き一覧で示すこと。',
    '- 各種目には少なくとも トレーニング名 / 部位 / 用具 / 頻度 / 重量 / 回数最小 / 回数最大 / セット / メモ を含めること。',
    '- 用具は マシン / フリー / 自重 / その他 のいずれかだけを使うこと。',
    '- 頻度は 1..8 の整数で表すこと。1 は毎日、8 は 8日+ を意味する。',
    '- デフォルトの新規セットは既定セットにしないこと。ただし既定セットが 0 件のユーザーに対して最初のセットを作ることは許容される。',
    '',
    '今回の作成条件:',
    `- 方針: ${policyLabel}`,
    `- 目標: ${goalLabel}`,
    `- 週間頻度: ${normalizeDaysPerWeek(form.daysPerWeek)}`,
    `- ジム施設入力: ${form.gymInput.trim() || '未指定'}`,
    `- 個別要求: ${form.freeTextRequest.trim() || 'なし'}`,
    '',
    `既存メニューセット名: ${existingSetNamesText}`,
    `既存トレーニング名: ${existingNamesText}`
  ].join('\n');
}

function buildRuntimeMessage(
  form: MenuGenerationFormState,
  userText: string,
  existingTrainingNames: string[],
  existingSetNames: string[]
): string {
  const fixedInstruction = buildFixedInstruction(form, existingTrainingNames, existingSetNames);
  return `${fixedInstruction}\n\n---\nユーザー入力:\n${userText.trim()}`;
}

function displayUserMessage(form: MenuGenerationFormState, text: string, isInitial: boolean): string {
  if (!isInitial) {
    return text.trim();
  }
  const policyLabel =
    form.policy === 'machine-only'
      ? 'マシンのみ'
      : form.policy === 'machine-plus-free'
        ? 'マシン + フリーウェイト'
        : 'フリーウェイトのみ';
  const goalLabel =
    form.goal === 'muscle-gain'
      ? '筋肥大'
      : form.goal === 'fat-loss'
        ? '減量'
        : '維持';
  return [
    `方針: ${policyLabel}`,
    `目標: ${goalLabel}`,
    `週間頻度: ${normalizeDaysPerWeek(form.daysPerWeek)}`,
    `ジム施設: ${form.gymInput.trim() || '未指定'}`,
    `個別要求: ${text.trim() || 'この条件で提案してください。'}`
  ].join('\n');
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

export function TrainingMenuAiGeneratePage() {
  const { isAuthenticated } = useAuth();
  const { data, refreshCoreData } = useAppState();
  const [form, setForm] = useState<MenuGenerationFormState>(initialFormState);
  const [session, setSession] = useState<MenuGenerationSessionState | null>(() => readStoredSession());
  const [chatInput, setChatInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusEvents, setStatusEvents] = useState<StatusEvent[]>([]);
  const [pageError, setPageError] = useState('');
  const [shouldRefreshAfterStream, setShouldRefreshAfterStream] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    persistSession(session);
  }, [session]);

  useEffect(() => {
    if (!listRef.current) {
      return;
    }
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [session?.messages.length, statusEvents.length, isStreaming]);

  const assistantAvatar = data.aiCharacterProfile.avatarImageUrl || '/assets/characters/default.png';
  const latestAssistantMessageId = useMemo(() => {
    const messages = session?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') {
        return messages[index].id;
      }
    }
    return undefined;
  }, [session?.messages]);
  const latestStatusEvent = statusEvents.length > 0 ? statusEvents[statusEvents.length - 1] : undefined;
  const hasConversation = (session?.messages.length ?? 0) > 0;
  const activeConditionKey = session?.conditionKey ?? '';
  const currentConditionKey = buildConditionKey(form);
  const hasConditionChanges = hasConversation && activeConditionKey !== currentConditionKey;
  const existingTrainingNames = useMemo(
    () => [...new Set(data.menuItems.map((item) => item.trainingName.trim()).filter(Boolean))],
    [data.menuItems]
  );
  const existingSetNames = useMemo(
    () => [...new Set(data.menuSets.map((set) => set.setName.trim()).filter(Boolean))],
    [data.menuSets]
  );

  function appendStatus(status: string, message: string) {
    setStatusEvents((prev) => [...prev.slice(-6), { id: messageId('menu-status'), status, message }]);
  }

  function appendUserMessage(content: string, nextSessionId: string, nextConditionKey: string) {
    const nextMessage: ChatMessage = {
      id: messageId('menu-user'),
      role: 'user',
      content,
      createdAtLocal: toLocalIsoWithOffset(new Date())
    };
    setSession((prev) => ({
      sessionId: nextSessionId,
      conditionKey: nextConditionKey,
      messages: [...(prev?.sessionId === nextSessionId ? prev.messages : []), nextMessage]
    }));
  }

  function createAssistantMessage(nextSessionId: string, nextConditionKey: string): string {
    const nextMessageId = messageId('menu-ai');
    const nextMessage: ChatMessage = {
      id: nextMessageId,
      role: 'assistant',
      content: '',
      createdAtLocal: toLocalIsoWithOffset(new Date())
    };
    setSession((prev) => ({
      sessionId: nextSessionId,
      conditionKey: nextConditionKey,
      messages: [...(prev?.sessionId === nextSessionId ? prev.messages : []), nextMessage]
    }));
    return nextMessageId;
  }

  function appendAssistantChunk(messageIdValue: string, chunk: string) {
    setSession((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        messages: prev.messages.map((message) =>
          message.id === messageIdValue ? { ...message, content: `${message.content}${chunk}` } : message
        )
      };
    });
  }

  async function sendToRuntime({
    userFacingMessage,
    runtimeMessage,
    nextSessionId,
    nextConditionKey,
    refreshAfterDone
  }: {
    userFacingMessage: string;
    runtimeMessage: string;
    nextSessionId: string;
    nextConditionKey: string;
    refreshAfterDone?: boolean;
  }) {
    if (!isAiRuntimeConfigured()) {
      setPageError('AI Runtime endpoint が未設定です。');
      return;
    }

    appendUserMessage(userFacingMessage, nextSessionId, nextConditionKey);
    const assistantMessageId = createAssistantMessage(nextSessionId, nextConditionKey);
    setPageError('');
    setIsStreaming(true);
    setStatusEvents([]);
    setShouldRefreshAfterStream(Boolean(refreshAfterDone));

    try {
      appendStatus('status', 'AI Runtimeへ接続しています...');
      await invokeAiRuntimeStream(
        {
          runtimeSessionId: nextSessionId,
          userMessage: runtimeMessage,
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
            appendAssistantChunk(assistantMessageId, event.chunk);
            return;
          }
          if (event.type === 'done') {
            setStatusEvents([]);
          }
        }
      );
      if (refreshAfterDone) {
        await refreshCoreData();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI Runtimeとの通信に失敗しました。';
      setPageError(message);
      appendAssistantChunk(assistantMessageId, `エラー: ${message}`);
    } finally {
      setShouldRefreshAfterStream(false);
      setStatusEvents([]);
      setIsStreaming(false);
    }
  }

  async function onStartProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isAuthenticated || isStreaming) {
      return;
    }
    const normalizedForm = {
      ...form,
      daysPerWeek: normalizeDaysPerWeek(form.daysPerWeek),
      gymInput: form.gymInput.trim(),
      freeTextRequest: form.freeTextRequest.trim()
    };
    if (!normalizedForm.gymInput) {
      setPageError('ジム施設入力は必須です。');
      return;
    }
    const nextConditionKey = buildConditionKey(normalizedForm);
    const nextSessionId = session && session.conditionKey === nextConditionKey ? session.sessionId : makeSessionId();
    if (!session || session.conditionKey !== nextConditionKey) {
      setSession({
        sessionId: nextSessionId,
        conditionKey: nextConditionKey,
        messages: []
      });
    }
    const userText = normalizedForm.freeTextRequest || 'この条件でトレーニングメニュー案を提案してください。';
    const runtimeMessage = buildRuntimeMessage(normalizedForm, userText, existingTrainingNames, existingSetNames);
    const userFacingMessage = displayUserMessage(normalizedForm, userText, true);
    await sendToRuntime({
      userFacingMessage,
      runtimeMessage,
      nextSessionId,
      nextConditionKey
    });
  }

  async function onSubmitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !isAuthenticated || isStreaming) {
      return;
    }
    const text = chatInput.trim();
    if (!text) {
      return;
    }
    setChatInput('');
    await sendToRuntime({
      userFacingMessage: text,
      runtimeMessage: buildRuntimeMessage(form, text, existingTrainingNames, existingSetNames),
      nextSessionId: session.sessionId,
      nextConditionKey: session.conditionKey
    });
  }

  async function onRegisterCurrentProposal() {
    if (!session || !isAuthenticated || isStreaming) {
      return;
    }
    const command = '現在の提案内容を、新規トレーニングメニューセットとして登録してください。既存メニューセットや既存メニューは変更せず、各種目はすべて新規作成し isAiGenerated=true で登録してください。既定セットは切り替えないでください。';
    await sendToRuntime({
      userFacingMessage: command,
      runtimeMessage: buildRuntimeMessage(form, command, existingTrainingNames, existingSetNames),
      nextSessionId: session.sessionId,
      nextConditionKey: session.conditionKey,
      refreshAfterDone: true
    });
  }

  function onResetSession() {
    if (isStreaming) {
      return;
    }
    setSession(null);
    setStatusEvents([]);
    setPageError('');
    setChatInput('');
    setShouldRefreshAfterStream(false);
  }

  return (
    <div className="stack-lg chat-page ai-menu-generation-page">
      <section className="card">
        <div className="row-wrap row-between ai-menu-generation-header">
          <div>
            <h1>AIメニュー生成</h1>
            <p className="muted">条件を変えると新しい会話で提案を始めます。</p>
          </div>
          <Link to="/training-menu" className="btn ghost">
            メニューへ戻る
          </Link>
        </div>

        <form className="stack-md" onSubmit={onStartProposal}>
          <div className="input-grid ai-menu-generation-grid">
            <label>
              方針
              <select value={form.policy} onChange={(e) => setForm((prev) => ({ ...prev, policy: e.target.value as MenuGenerationPolicy }))}>
                <option value="machine-only">マシンのみ</option>
                <option value="machine-plus-free">マシン + フリーウェイト</option>
                <option value="free-only">フリーウェイトのみ</option>
              </select>
            </label>
            <label>
              目標
              <select value={form.goal} onChange={(e) => setForm((prev) => ({ ...prev, goal: e.target.value as MenuGenerationGoal }))}>
                <option value="muscle-gain">筋肥大</option>
                <option value="fat-loss">減量</option>
                <option value="maintain">維持</option>
              </select>
            </label>
            <label>
              週間頻度
              <input
                type="number"
                min={1}
                max={7}
                value={form.daysPerWeek}
                onChange={(e) => setForm((prev) => ({ ...prev, daysPerWeek: normalizeDaysPerWeek(Number(e.target.value)) }))}
              />
            </label>
          </div>

          <label>
            ジム施設入力
            <input
              type="text"
              placeholder="例: エニタイム荻窪店 / 設備説明URL"
              value={form.gymInput}
              onChange={(e) => setForm((prev) => ({ ...prev, gymInput: e.target.value }))}
            />
          </label>

          <label>
            個別要求
            <textarea
              rows={3}
              placeholder="例: 胸と背中を厚めにしたい。肩は軽め。"
              value={form.freeTextRequest}
              onChange={(e) => setForm((prev) => ({ ...prev, freeTextRequest: e.target.value }))}
            />
          </label>

          <div className="row-wrap">
            <button type="submit" className="btn primary" disabled={!isAuthenticated || isStreaming}>
              {hasConditionChanges ? '条件変更で新しい提案を開始' : 'AIに提案してもらう'}
            </button>
            {session && (
              <button type="button" className="btn ghost" disabled={isStreaming} onClick={onResetSession}>
                新規チャット
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="card chat-header-card chat-header-compact">
        <div className="chat-agent-head">
          <img src={assistantAvatar} alt={data.aiCharacterProfile.characterName} className="avatar-medium" />
          <div>
            <p className="eyebrow">AI コーチ</p>
            <h2>{data.aiCharacterProfile.characterName}</h2>
          </div>
        </div>
      </section>

      <section className="chat-body card" ref={listRef}>
        {(session?.messages.length ?? 0) === 0 ? (
          <p className="muted">条件を送信すると、ここに提案内容とやり取りが表示されます。</p>
        ) : (
          session?.messages.map((message) => {
            const isAssistant = message.role === 'assistant';
            const showStatusAboveAssistant =
              isStreaming && isAssistant && message.id === latestAssistantMessageId && Boolean(latestStatusEvent);

            return (
              <div key={message.id}>
                {showStatusAboveAssistant && latestStatusEvent && (
                  <div className="chat-status-inline" aria-live="polite">
                    <span className="chat-status-label">Runtime {latestStatusEvent.status}</span>
                    <span className="chat-status-text">{latestStatusEvent.message}</span>
                  </div>
                )}
                <div className={isAssistant ? 'message-row assistant' : 'message-row user'}>
                  {isAssistant && <img src={assistantAvatar} alt={data.aiCharacterProfile.characterName} className="avatar-small" />}
                  <div className={isAssistant ? 'message-bubble assistant' : 'message-bubble user'}>
                    {isAssistant && <p className="message-name">{data.aiCharacterProfile.characterName}</p>}
                    <MarkdownMessage content={message.content} />
                  </div>
                </div>
              </div>
            );
          })
        )}
      </section>

      <form className="card chat-input" onSubmit={onSubmitChat}>
        <textarea
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          placeholder="例: 脚は軽めにして、肩を増やしてください"
          rows={3}
          disabled={!session || isStreaming || !isAuthenticated}
        />
        {pageError && <p className="form-error">{pageError}</p>}
        {shouldRefreshAfterStream && <p className="muted">登録後にメニューを再取得します。</p>}
        <div className="chat-input-actions ai-menu-generation-actions">
          <button
            type="button"
            className="btn ghost"
            disabled={!session || isStreaming || !isAuthenticated}
            onClick={onRegisterCurrentProposal}
          >
            この内容で登録
          </button>
          <button
            className="btn primary chat-send-icon-button"
            type="submit"
            disabled={!session || isStreaming || !chatInput.trim() || !isAuthenticated}
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
