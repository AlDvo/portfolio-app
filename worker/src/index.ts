/**
 * Прокси к Gemini API для оценки облигации/эмитента.
 *
 * Зачем прокси, а не вызов из браузера: ключ Gemini не должен попадать в публичный
 * бандл GitHub Pages. Здесь он живёт в secret-переменной окружения и в клиент не уходит.
 *
 * Ограничения бесплатного тарифа, на которые опирается этот код:
 *  - Google Search Grounding доступен на Free Tier только для Flash/Flash-Lite, не для Pro;
 *  - лимит 500 запросов в сутки на Search (RPD).
 * Поэтому модель по умолчанию — Flash, а не Pro.
 */

export interface Env {
  GEMINI_API_KEY?: string;
  /** По умолчанию gemini-3.8-flash: grounding недоступен для Pro на бесплатном тарифе. */
  GEMINI_MODEL?: string;
  /** Список через запятую. Пусто = проверка origin не выполняется. */
  ALLOWED_ORIGINS?: string;
  /** Секрет-ворота к Worker'у. Если не задан, запросы отклоняются (fail closed). */
  ACCESS_TOKEN?: string;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    groundingMetadata?: { groundingChunks?: GeminiGroundingChunk[] };
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
// Gemini отклонил gemini-2.5-flash для новых аккаунтов («no longer available to new
// users») и указал эту; не понижать версию без проверки живым запросом.
const DEFAULT_MODEL = 'gemini-3.8-flash';

/**
 * Методика довольно длинная, а Flash с включённым thinking отвечает минутами.
 * 240 с — с запасом; при превышении клиент получает внятную ошибку, а не висящий запрос.
 */
const UPSTREAM_TIMEOUT_MS = 240_000;

const MAX_PROMPT_CHARS = 120_000;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // Authorization обязателен: без него в списке браузер отклонит preflight
  // запроса с токеном и UI получит CORS-ошибку вместо 401.
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status: number, origin: string | null): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

function fail(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}

/**
 * Разрешён ли источник запроса, и какое значение писать в Access-Control-Allow-Origin.
 * Отсутствие заголовка Origin (curl, wrangler dev) — не отказ: такие запросы проходят,
 * а заголовок CORS тогда просто не выставляется.
 */
function resolveOrigin(request: Request, env: Env): { ok: boolean; header: string | null } {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (allowed.length === 0) return { ok: true, header: origin };
  if (origin === null) return { ok: true, header: null };

  const ok = allowed.some((o) => o === origin || o === '*');
  return { ok, header: ok ? origin : null };
}

/** Есть ли в тексте обязательные разделы методики — защита от отправки «полуметодики». */
function looksLikeMethodology(prompt: string): boolean {
  return prompt.includes('§3.1') && prompt.includes('§19А') && prompt.includes('§20');
}

/**
 * Сравнение без утечки времени по длине/префиксу: цикл всегда идёт до maxLen,
 * различие копится в diff и наружу не возвращается.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

type AccessVerdict = 'ok' | 'missing' | 'denied' | 'unconfigured';

/**
 * Токен доступа — основной контроль доступа; allowlist origin остаётся вторым эшелоном.
 * Если секрет не задан, ворота закрыты: иначе забытый `secret put` тихо оставил бы
 * эндпоинт открытым на чужую квоту.
 */
function checkAccess(request: Request, env: Env): AccessVerdict {
  const expected = env.ACCESS_TOKEN?.trim();
  if (!expected) return 'unconfigured';

  const header = request.headers.get('Authorization') ?? '';
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return 'missing';

  return timingSafeEqual(match[1].trim(), expected) ? 'ok' : 'denied';
}

async function readPrompt(request: Request): Promise<string | { error: string }> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/json')) {
    return { error: 'Ожидается Content-Type: application/json' };
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { error: 'Тело запроса не является корректным JSON' };
  }

  const prompt = (parsed as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { error: 'Поле prompt обязательно и должно быть непустой строкой' };
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { error: `Промпт длиннее лимита (${MAX_PROMPT_CHARS} символов)` };
  }
  if (!looksLikeMethodology(prompt)) {
    return { error: 'Промпт не содержит методику v6.0-К: нужны §3.1, §19А и §20' };
  }

  return prompt;
}

function collectText(data: GeminiResponse): string {
  return (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.thought !== true)
    .map((p) => p.text ?? '')
    .join('')
    .trim();
}

function collectSources(data: GeminiResponse): { title: string; uri: string }[] {
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  const sources: { title: string; uri: string }[] = [];

  for (const chunk of chunks) {
    const uri = chunk.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: chunk.web?.title ?? uri, uri });
  }
  return sources;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { ok: originOk, header: origin } = resolveOrigin(request, env);
    if (!originOk) {
      return fail('Источник запроса не разрешён', 403, null);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS, ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) } });
    }
    if (request.method !== 'POST') {
      return fail('Метод не поддерживается, используйте POST', 405, origin);
    }

    const access = checkAccess(request, env);
    if (access === 'unconfigured') {
      return fail(
        'Токен доступа не настроен: задайте secret ACCESS_TOKEN (wrangler secret put ACCESS_TOKEN).',
        503,
        origin,
      );
    }
    if (access === 'missing') {
      return fail('Не передан заголовок Authorization: Bearer <токен>', 401, origin);
    }
    if (access === 'denied') {
      return fail('Токен доступа неверный', 401, origin);
    }

    if (!env.GEMINI_API_KEY) {
      return fail(
        'Ключ Gemini не настроен: задайте secret GEMINI_API_KEY (wrangler secret put GEMINI_API_KEY).',
        503,
        origin,
      );
    }

    const prompt = await readPrompt(request);
    if (typeof prompt !== 'string') {
      return fail(prompt.error, 400, origin);
    }

    const model = env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;

    let upstream: Response;
    try {
      upstream = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
      return fail(
        timedOut
          ? `Gemini не ответил за ${UPSTREAM_TIMEOUT_MS / 1000} с. Повторите попытку.`
          : 'Не удалось соединиться с Gemini API.',
        502,
        origin,
      );
    }

    const raw = await upstream.text();

    if (!upstream.ok) {
      let detail = raw.slice(0, 500);
      try {
        const parsed = JSON.parse(raw) as GeminiResponse;
        detail = parsed.error?.message ?? detail;
      } catch {
        // тело не JSON — оставляем обрезанный текст как есть
      }

      if (upstream.status === 429) {
        return fail(
          'Лимит Gemini исчерпан (429). Суточный лимит считается на проект, а не на ключ, ' +
            'и сбрасывается в полночь по Pacific (00:00 PT). Текущее usage: ' +
            'https://ai.dev/rate-limit. Пока лимит не восстановлен, используйте ручной режим.',
          429,
          origin,
        );
      }
      if (upstream.status === 400 && /API key not valid/i.test(detail)) {
        return fail('Ключ Gemini отклонён (проверьте GEMINI_API_KEY).', 502, origin);
      }
      return fail(`Gemini API вернул ${upstream.status}: ${detail}`, 502, origin);
    }

    let data: GeminiResponse;
    try {
      data = JSON.parse(raw) as GeminiResponse;
    } catch {
      return fail('Gemini вернул нечитаемый ответ', 502, origin);
    }

    const blocked = data.promptFeedback?.blockReason;
    if (blocked) {
      return fail(`Запрос отклонён Gemini (${blocked})`, 400, origin);
    }

    const text = collectText(data);
    if (!text) {
      return fail('Gemini вернул пустой ответ', 502, origin);
    }

    return json({ text, sources: collectSources(data), model }, 200, origin);
  },
} satisfies ExportedHandler<Env>;
