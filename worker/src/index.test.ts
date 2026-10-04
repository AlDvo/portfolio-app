import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.ts';

const ORIGIN = 'https://aldvo.github.io';
const DEV_ORIGIN = 'http://localhost:5173';
const TOKEN = 'test-token-0123456789';

const env = {
  GEMINI_API_KEY: 'test-key',
  ALLOWED_ORIGINS: `${ORIGIN},${DEV_ORIGIN}`,
  ACCESS_TOKEN: TOKEN,
};

const METHODOLOGY_PROMPT = '§3.1 ... §19А ... §20 ...';

function post(body: unknown, headers: Record<string, string> = {}, e: unknown = env) {
  return worker.fetch(
    new Request('https://w.dev/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        Authorization: `Bearer ${TOKEN}`,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    e as never,
  );
}

async function callWithStub(response: Response, request: Request, e: unknown = env) {
  const realFetch = globalThis.fetch;
  let sent: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    sent = { url: String(url), init: init as RequestInit };
    return response;
  }) as typeof globalThis.fetch;
  try {
    return { res: await worker.fetch(request, e as never), sent: sent! };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const jsonResp = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const geminiOk = () =>
  jsonResp({
    candidates: [
      {
        content: { parts: [{ text: 'Краткий вывод: ' }, { text: 'НЕ ПОКУПАТЬ' }] },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://example.com/a', title: 'A' } },
            { web: { uri: 'https://example.com/a' } },
            { web: { uri: 'https://example.com/b', title: 'B' } },
          ],
        },
      },
    ],
  });

const authedPost = (body: unknown = { prompt: METHODOLOGY_PROMPT }, auth = `Bearer ${TOKEN}`) =>
  new Request('https://w.dev/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });

// --- Гейт доступа ---

test('без ACCESS_TOKEN ворота закрыты (fail closed)', async () => {
  const res = await post({ prompt: METHODOLOGY_PROMPT }, {}, { GEMINI_API_KEY: 'k' });
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /ACCESS_TOKEN/);
});

test('без заголовка Authorization — 401 с отдельным текстом', async () => {
  const res = await post({ prompt: METHODOLOGY_PROMPT }, { Authorization: '' });
  assert.equal(res.status, 401);
  assert.match(((await res.json()) as { error: string }).error, /Не передан заголовок/);
});

test('с неверным токеном — 401 даже при разрешённом origin', async () => {
  const res = await post({ prompt: METHODOLOGY_PROMPT }, { Authorization: 'Bearer wrong' });
  assert.equal(res.status, 401);
  assert.match(((await res.json()) as { error: string }).error, /Токен доступа неверный/);
});

test('токен в кавычках не проходит', async () => {
  const res = await post({ prompt: METHODOLOGY_PROMPT }, { Authorization: `Bearer "${TOKEN}"` });
  assert.equal(res.status, 401);
});

test('схема Bearer регистронезависима', async () => {
  const { res } = await callWithStub(geminiOk(), authedPost(undefined, `bearer ${TOKEN}`));
  assert.equal(res.status, 200);
});

test('токен не утекает в запрос к Gemini', async () => {
  const { sent } = await callWithStub(geminiOk(), authedPost());
  assert.ok(!JSON.stringify(sent.init).includes(TOKEN), 'токен не должен попадать в upstream');
});

// --- Транспорт и CORS ---

test('OPTIONS отвечает 204 и отражает origin', async () => {
  const res = await worker.fetch(
    new Request('https://w.dev/', { method: 'OPTIONS', headers: { Origin: ORIGIN } }),
    env as never,
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('OPTIONS разрешает заголовок Authorization', async () => {
  // Регрессия: без Authorization в Allow-Headers браузер отклоняет preflight
  // запроса с токеном, и UI получает CORS-ошибку вместо ответа Worker'а.
  const res = await worker.fetch(
    new Request('https://w.dev/', { method: 'OPTIONS', headers: { Origin: ORIGIN } }),
    env as never,
  );
  const allowed = res.headers.get('Access-Control-Allow-Headers') ?? '';
  assert.match(allowed, /Authorization/i);
  assert.match(allowed, /Content-Type/i);
});

test('OPTIONS не требует токен', async () => {
  const res = await worker.fetch(
    new Request('https://w.dev/', { method: 'OPTIONS', headers: { Origin: ORIGIN } }),
    { ACCESS_TOKEN: '' } as never,
  );
  assert.equal(res.status, 204);
});

test('GET отклоняется как 405, а не как 403', async () => {
  // Регрессия: отсутствие Origin не должно читаться как отказ по allowlist.
  const res = await worker.fetch(
    new Request('https://w.dev/', { method: 'GET' }),
    env as never,
  );
  assert.equal(res.status, 405);
});

test('чужой origin даёт 403', async () => {
  const res = await post({ prompt: METHODOLOGY_PROMPT }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('пустой ALLOWED_ORIGINS отключает проверку origin', async () => {
  const { res } = await callWithStub(
    geminiOk(),
    authedPost(),
    { GEMINI_API_KEY: 'k', ACCESS_TOKEN: TOKEN },
  );
  assert.equal(res.status, 200);
});

// --- Валидация запроса ---

test('без GEMINI_API_KEY отдаёт 503 и объясняет настройку', async () => {
  const res = await post({ prompt: METHODOLOGY_PROMPT }, {}, { ACCESS_TOKEN: TOKEN });
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /GEMINI_API_KEY/);
});

test('неверный Content-Type даёт 400', async () => {
  const res = await worker.fetch(
    new Request('https://w.dev/', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: ORIGIN,
        Authorization: `Bearer ${TOKEN}`,
      },
      body: 'x',
    }),
    env as never,
  );
  assert.equal(res.status, 400);
});

test('битый JSON даёт 400', async () => {
  assert.equal((await post('{oops')).status, 400);
});

test('пустой промпт даёт 400', async () => {
  assert.equal((await post({ prompt: '   ' })).status, 400);
});

test('промпт без методики отклоняется и перечисляет нужные разделы', async () => {
  const res = await post({ prompt: 'просто оцени' });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /§3\.1/);
});

// --- Обращение к Gemini ---

test('запрос к Gemini собран верно', async () => {
  const { res, sent } = await callWithStub(geminiOk(), authedPost());
  assert.equal(res.status, 200);
  assert.match(sent.url, /models\/gemini-[^/]+:generateContent$/);
  assert.equal((sent.init.headers as Record<string, string>)['x-goog-api-key'], 'test-key');

  const body = JSON.parse(String(sent.init.body));
  assert.ok(Array.isArray(body.tools) && 'google_search' in body.tools[0]);
  assert.equal(body.contents[0].parts[0].text, METHODOLOGY_PROMPT);
  assert.equal(body.generationConfig.temperature, 0.2);
});

test('текст склеивается из всех частей, источники дедуплицируются', async () => {
  const { res, sent } = await callWithStub(geminiOk(), authedPost());
  const body = (await res.json()) as { text: string; sources: unknown[]; model: string };
  assert.equal(body.text, 'Краткий вывод: НЕ ПОКУПАТЬ');
  assert.equal(body.sources.length, 2);
  assert.equal(body.model, sent.url.split('/models/')[1].replace(':generateContent', ''));
});

test('мыслительные части не попадают в отчёт', async () => {
  const { res } = await callWithStub(
    jsonResp({
      candidates: [
        {
          content: {
            parts: [
              { text: 'Сначала подумаю про эмитента', thought: true },
              { text: 'Итог: НЕ ПОКУПАТЬ' },
            ],
          },
        },
      ],
    }),
    authedPost(),
  );
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { text: string }).text, 'Итог: НЕ ПОКУПАТЬ');
});

test('лимит Gemini (429) даёт actionable-сообщение со сбросом и ссылкой', async () => {
  const { res } = await callWithStub(
    jsonResp({ error: { message: 'quota exceeded' } }, 429),
    authedPost(),
  );
  assert.equal(res.status, 429);
  const { error } = (await res.json()) as { error: string };
  assert.match(error, /на проект, а не на ключ/);
  assert.match(error, /Pacific/);
  assert.match(error, /ai\.dev\/rate-limit/);
  assert.match(error, /ручн/);
});

test('пустой candidates от upstream даёт 502', async () => {
  const { res } = await callWithStub(
    jsonResp({ candidates: [{ content: { parts: [] } }] }),
    authedPost(),
  );
  assert.equal(res.status, 502);
});

test('запрос без Origin (curl) проходит при верном токене', async () => {
  const { res } = await callWithStub(
    geminiOk(),
    new Request('https://w.dev/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ prompt: METHODOLOGY_PROMPT }),
    }),
  );
  assert.equal(res.status, 200);
});
