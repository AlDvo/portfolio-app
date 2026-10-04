import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { buildBondRatingPrompt } from './bondRatingPrompt';
import { autoRatingAvailable, requestRating, ratingEndpoint, setAccessToken, RatingError } from './ratingApi';
import type { RatingErrorKind, RatingSource } from './ratingApi';

const ERROR_TITLES: Record<RatingErrorKind, string> = {
  quota: 'Дневной лимит Google исчерпан',
  auth: 'Не удалось войти — проверьте токен',
  network: 'Worker недоступен',
  server: 'Ошибка на стороне сервиса',
};

/** Сколько символов показывать в превью промпта. */
const PREVIEW_LIMIT = 120_000;

/**
 * Оценка облигации/эмитента: автоматический режим через Worker с Gemini
 * и ручной режим (копирование промпта в чат) как запасной путь.
 */
export function BondRatingPage() {
  const [query, setQuery] = useState('');
  const [token, setToken] = useState('');
  const [answer, setAnswer] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [queryError, setQueryError] = useState<string | null>(null);
  const [autoError, setAutoError] = useState<RatingError | null>(null);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<RatingSource[]>([]);
  const [model, setModel] = useState<string | undefined>(undefined);
  // Оба вида ответа рендерятся одинаково, но подпись с endpoint'ом верна только для ответа Worker'а.
  const [fromAuto, setFromAuto] = useState(false);

  const prompt = useMemo(() => {
    if (!query.trim()) return null;
    try {
      return buildBondRatingPrompt(query);
    } catch (e) {
      return null;
    }
  }, [query]);

  const copyPrompt = async () => {
    if (!prompt) {
      setQueryError('Введите ISIN, тикер или название эмитента.');
      return;
    }
    setQueryError(null);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const runAuto = async () => {
    if (!prompt) {
      setQueryError('Введите ISIN, тикер или название эмитента.');
      return;
    }
    setQueryError(null);
    setAutoError(null);
    setLoading(true);
    try {
      const result = await requestRating(prompt);
      setAnswer(result.text);
      setSources(result.sources);
      setModel(result.model);
      setFromAuto(true);
    } catch (e) {
      setAutoError(
        e instanceof RatingError ? e : new RatingError('server', String(e)),
      );
    } finally {
      setLoading(false);
    }
  };

  const hasAnswer = answer.trim().length > 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">Оценка облигации/эмитента</div>
      </header>

      <section className="card rating-card">
        <div className="rating-step">
          <div className="rating-step-title">Токен доступа</div>
          <div className="rating-hint">
            Нужен для автоматического режима. Хранится только в памяти вкладки и исчезает при
            перезагрузке — в браузере и в коде сайта его не остаётся.
          </div>
          <div className="rating-row">
            <input
              type="password"
              className="rating-input"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setAccessToken(e.target.value);
              }}
              placeholder="Вставьте токен"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {!autoRatingAvailable && (
            <div className="rating-note">
              Автоматический режим не настроен: не задана переменная VITE_RATING_API_URL (URL
              Worker'а). Токен здесь не поможет — используйте ручной режим ниже.
            </div>
          )}
          {autoError && (
            <div
              className={
                autoError.kind === 'quota' ? 'quota-banner' : 'error-banner'
              }
            >
              <div>
                <div className="banner-title">{ERROR_TITLES[autoError.kind]}</div>
                <div className="banner-detail">{autoError.message}</div>
              </div>
            </div>
          )}
        </div>

        <div className="rating-step">
          <div className="rating-step-title">1. Что оцениваем</div>
          <div className="rating-hint">
            ISIN, тикер или название эмитента. Методика v6.0-К добавится к запросу автоматически.
          </div>
          <div className="rating-row">
            <input
              type="text"
              className="rating-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Например: RU000A105SD9 или Газпромбанк"
            />
            <button
              type="button"
              onClick={runAuto}
              disabled={loading || !autoRatingAvailable || token.trim() === ''}
            >
              {loading ? 'Оценка…' : 'Оценить автоматически'}
            </button>
            <button type="button" onClick={copyPrompt}>
              Скопировать промпт
            </button>
          </div>
          {loading && (
            <div className="rating-note">
              Gemini с поиском по источникам отвечает несколько минут. Не закрывайте страницу.
            </div>
          )}
          {copyState === 'copied' && <div className="rating-ok">Промпт скопирован в буфер обмена.</div>}
          {copyState === 'failed' && (
            <div className="rating-note">
              Браузер запретил доступ к буферу. Откройте страницу по HTTPS или localhost — либо выделите
              промпт ниже и скопируйте вручную.
            </div>
          )}
          {queryError && <div className="rating-note">{queryError}</div>}
        </div>

        {prompt && (
          <details className="rating-details">
            <summary>Показать промпт ({prompt.length.toLocaleString('ru-RU')} симв.)</summary>
            <pre className="rating-prompt">{prompt.slice(0, PREVIEW_LIMIT)}</pre>
            {prompt.length > PREVIEW_LIMIT && (
              <div className="rating-note">
                Показаны первые {PREVIEW_LIMIT.toLocaleString('ru-RU')} символов. Копируйте по кнопке выше —
                она кладёт в буфер полный текст.
              </div>
            )}
          </details>
        )}

        {hasAnswer && (
          <div className="rating-step">
            <div className="rating-step-title">
              Отчёт{' '}
              {fromAuto && model && <span className="rating-model">{model}</span>}
              {fromAuto && ratingEndpoint && (
                <span className="rating-model"> · {ratingEndpoint}</span>
              )}
            </div>
            {sources.length > 0 && (
              <details className="rating-details">
                <summary>Источники, найденные поиском ({sources.length})</summary>
                <ul className="rating-sources">
                  {sources.map((s) => (
                    <li key={s.uri}>
                      <a href={s.uri} target="_blank" rel="noreferrer noopener">
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="rating-report">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
            </div>
          </div>
        )}

        {!hasAnswer && (
          <div className="rating-step">
            <div className="rating-step-title">Отчёт вручную</div>
            <div className="rating-hint">
              Вставьте промпт в чат (DeepSeek и т.п.) и вставьте полученный ответ сюда. Приложение
              только отображает его — проверка и интерпретация остаются за вами.
            </div>
            <textarea
              className="rating-textarea"
              value={answer}
              onChange={(e) => {
                setAnswer(e.target.value);
                setFromAuto(false);
                setSources([]);
                setModel(undefined);
              }}
              placeholder="Вставьте полученный отчёт сюда…"
              rows={10}
            />
          </div>
        )}
      </section>
    </div>
  );
}
