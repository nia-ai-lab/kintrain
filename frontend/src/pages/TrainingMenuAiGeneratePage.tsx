import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { invokeAiRuntimeStream, isAiRuntimeConfigured } from '../api/aiRuntimeApi';
import { useAppState, useTodayYmd } from '../AppState';
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
  validFromDate: string;
  validToDate: string;
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
  freeTextRequest: '',
  validFromDate: '',
  validToDate: ''
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
    freeTextRequest: form.freeTextRequest.trim(),
    validFromDate: form.validFromDate,
    validToDate: form.validToDate
  });
}

function buildFixedInstruction(
  form: MenuGenerationFormState,
  existingTrainingNames: string[],
  existingSetNames: string[],
  validFromDate: string,
  validToDate: string
): string {
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
    'これは KinTrain の「一時メニュー」作成依頼です。',
    'あなたの仕事は、ユーザー条件に合わせた一時メニューセットを提案し、ユーザーが明示的に登録を指示した時だけ MCP ツールで指定期間の計画として登録することです。',
    '重要ルール:',
    '- 既存のトレーニングメニューセットや既存のトレーニングメニューは絶対に更新・削除・上書きしないこと。',
    '- 既存種目を使う場合は list_training_menu_items の trainingMenuItemId を指定して再利用すること。',
    '- 適切な既存種目がない場合は新規種目マスタを作成してよいこと。',
    '- 1つの一時セット内で既存種目と新規種目を混在させてよいこと。',
    '- ユーザーが「登録して」「この内容で保存して」など明示的に指示するまで、登録ツールを呼び出してはならない。',
    '- 新規種目を作る前に list_training_menu_items で重複を確認すること。同じ種目があれば既存IDを使うこと。',
    '- ジム設備情報が名称だけで不確かな場合はユーザーに確認すること。確認しても不明なままなら、設備不明前提の仮案を出すこと。',
    '- 提案時は自然文の説明に加えて、登録可能なメニューセット案を分かりやすい Markdown の番号付き一覧で示すこと。',
    '- 各種目には少なくとも 種目 / 目標重量 / 目標回数最小 / 目標回数最大 / 目標セット数 / 推奨間隔 を含めること。',
    '- 用具は マシン / フリー / 自重 / その他 のいずれかだけを使うこと。',
    '- 重量は 0 以上とし、自重種目は追加重量なしを 0kg で表してよい。',
    '- 頻度は 1..8 の整数で表すこと。1 は毎日、8 は 8日+ を意味する。',
    '- 1回のツール呼び出しでは、指定した有効期間に共通して使う1つの一時メニューセットを登録すること。',
    '- 日によって内容を変える場合は、重ならない有効期間に分け、必要な回数だけ登録ツールを呼び出してよい。',
    '- 複数日を束ねる計画オブジェクトは作らず、各一時メニューセットの有効期間で表現すること。',
    '- トレーニング名は純粋な種目名だけにすること。ジム名、AI、プラン名、曜日名、連番など不要な接頭辞・接尾辞を入れてはならない。',
    '- 一時セットはデフォルトセットにしないこと。',
    '- 登録には create_temporary_training_menu_set_from_ai を使い、validFromDate、validToDate と一意な idempotencyKey を必ず渡すこと。',
    '- 期間内に既存の一時メニューがあるとツールが返した場合、ユーザーへ置き換え確認を行い、承認後だけ replaceExistingPlan=true で再実行すること。',
    '',
    '今回の作成条件:',
    `- 方針: ${policyLabel}`,
    `- 目標: ${goalLabel}`,
    `- 週間頻度: ${normalizeDaysPerWeek(form.daysPerWeek)}`,
    `- ジム施設入力: ${form.gymInput.trim() || '未指定'}`,
    `- 個別要求: ${form.freeTextRequest.trim() || 'なし'}`,
    `- 有効期間: ${validFromDate}〜${validToDate}`,
    '',
    `既存メニューセット名: ${existingSetNamesText}`,
    `既存トレーニング名: ${existingNamesText}`
  ].join('\n');
}

function buildRuntimeMessage(
  form: MenuGenerationFormState,
  userText: string,
  existingTrainingNames: string[],
  existingSetNames: string[],
  validFromDate: string,
  validToDate: string
): string {
  const fixedInstruction = buildFixedInstruction(form, existingTrainingNames, existingSetNames, validFromDate, validToDate);
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
    `有効期間: ${form.validFromDate}〜${form.validToDate}`,
    `ジム施設: ${form.gymInput.trim() || '未指定'}`,
    `個別要求: ${text.trim() || 'この条件で提案してください。'}`
  ].join('\n');
}

function validateInitialForm(form: MenuGenerationFormState): string | null {
  if (!form.gymInput.trim()) {
    return 'ジム施設入力は必須です。ジム名称または設備説明URLを入力してください。';
  }
  if (!form.validFromDate || !form.validToDate || form.validFromDate > form.validToDate) {
    return '有効開始日と有効終了日を正しく指定してください。';
  }
  const start = new Date(`${form.validFromDate}T00:00:00Z`);
  const end = new Date(`${form.validToDate}T00:00:00Z`);
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days < 1 || days > 31) {
    return '一時メニューの有効期間は31日以内で指定してください。';
  }
  const daysPerWeek = Number(form.daysPerWeek);
  if (!Number.isFinite(daysPerWeek) || daysPerWeek < 1 || daysPerWeek > 7) {
    return '週間頻度は 1〜7 の整数で入力してください。';
  }
  return null;
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
  const today = useTodayYmd();
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
    setForm((prev) => ({
      ...prev,
      validFromDate: prev.validFromDate || today,
      validToDate: prev.validToDate || today
    }));
  }, [today]);

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
    () => [...new Set(data.menuItems.map((item) => `${item.id}: ${item.trainingName.trim()}`).filter(Boolean))],
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
    const validationError = validateInitialForm(normalizedForm);
    if (validationError) {
      setPageError(validationError);
      return;
    }
    setPageError('');
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
    const runtimeMessage = buildRuntimeMessage(
      normalizedForm,
      userText,
      existingTrainingNames,
      existingSetNames,
      normalizedForm.validFromDate,
      normalizedForm.validToDate
    );
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
      runtimeMessage: buildRuntimeMessage(form, text, existingTrainingNames, existingSetNames, form.validFromDate, form.validToDate),
      nextSessionId: session.sessionId,
      nextConditionKey: session.conditionKey
    });
  }

  async function onRegisterCurrentProposal() {
    if (!session || !isAuthenticated || isStreaming) {
      return;
    }
    const command = `現在の提案内容を ${form.validFromDate} から ${form.validToDate} まで有効な一時メニューセットとして登録してください。既存種目はIDで再利用し、該当する既存種目がない場合だけ新規種目を作成してください。一意なidempotencyKeyを生成し、create_temporary_training_menu_set_from_aiで登録してください。`;
    await sendToRuntime({
      userFacingMessage: command,
      runtimeMessage: buildRuntimeMessage(form, command, existingTrainingNames, existingSetNames, form.validFromDate, form.validToDate),
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
          {pageError && <p className="form-error">{pageError}</p>}
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

          <div className="menu-validity-grid">
            <label>
              有効開始日
              <input
                type="date"
                value={form.validFromDate}
                onChange={(e) => setForm((prev) => ({ ...prev, validFromDate: e.target.value }))}
              />
            </label>
            <label>
              有効終了日
              <input
                type="date"
                min={form.validFromDate}
                value={form.validToDate}
                onChange={(e) => setForm((prev) => ({ ...prev, validToDate: e.target.value }))}
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
        {pageError && session && <p className="form-error">{pageError}</p>}
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
