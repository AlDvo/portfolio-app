# Worker оценки облигации

Прокси к Gemini API. Ключ хранится в secret Cloudflare и в клиент не попадает —
сайт статический и раздаётся с публичных GitHub Pages.

Модель — `gemini-3.8-flash`: Google Search Grounding на бесплатном тарифе Gemini
доступен только для Flash/Flash-Lite, для Pro — нет. Модель переопределяется
переменной `GEMINI_MODEL` в `wrangler.toml`.

## Один раз: настройка

1. Получите бесплатный ключ Gemini (карта не нужна): https://aistudio.google.com/apikey
2. Залогиньтесь в Cloudflare и создайте Worker либо выполните `wrangler login`.
3. Задайте ключ в самом Worker (не в репозитории):

   ```bash
   npx wrangler secret put GEMINI_API_KEY
   ```

4. Придумайте токен доступа и задайте его вторым секретом:

   ```bash
   npx wrangler secret put ACCESS_TOKEN
   ```

   Токен — не ключ Gemini, а отдельный секрет-пароль на вход в автоматический режим.
   Пока он не задан, Worker отвечает 503 на всё: забытый `secret put` не должен
   молча оставить эндпоинт открытым на чужую квоту.

   Сгенерировать токен:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

5. Убедитесь, что в `wrangler.toml` в `ALLOWED_ORIGINS` указан origin вашего сайта
   (по умолчанию `https://aldvo.github.io` и `http://localhost:5173`).
   Пустой список отключает проверку — не оставляйте его пустым в проде.
   Основной контроль доступа — токен; allowlist origin второй эшелон и держит
   браузерные cross-origin запросы.

## Локальная разработка

```bash
npm install
cp .dev.vars.example .dev.vars   # вписать ключ; файл в .gitignore
npm run dev                      # http://localhost:8787
```

`.dev.vars` не коммитится. В UI dev-сервер проксирует `/api/rating` на этот порт,
поэтому `npm run dev` в `ui/` работает с автоматическим режимом без настройки.

Ручной режим (копирование промпта в чат) доступен всегда и не требует Worker'а.

## Проверки

```bash
npm test         # node:test, fetch к Gemini подменён — сетевых вызовов нет
npm run typecheck
```

Тесты закрывают границы безопасности: allowlist origin, отклонение не-POST, отсутствие
`Origin` у curl/wrangler dev, отказ промпту без методики, проброс квоты 429 и склейка
частей ответа. Ключ в тестах — заглушка; реальный ключ не нужен.

## Деплой

```bash
npm run deploy
```

Либо автоматически: workflow `.github/workflows/worker.yml` деплоит Worker при пуше
изменений в `worker/**` в ветку `main`. Для него нужны secrets репозитория:

- `CF_API_TOKEN` — токен Cloudflare (Workers Scripts: Edit)
- `CF_ACCOUNT_ID` — ID аккаунта

URL задеплоенного Worker нужно указать в GitHub: **Settings → Secrets and variables
→ Actions → Variables → `VITE_RATING_API_URL`** (это variable, не secret: значение
и так публично). Без неё UI соберётся без автоматического режима, но продолжит
работать в ручном.

## Контракт

`POST /` с заголовком `Authorization: Bearer <ACCESS_TOKEN>` и телом
`{ "prompt": "<промпт с методикой v6.0-К>" }`

```jsonc
// 200
{
  "text": "…отчёт в markdown…",
  "sources": [{ "title": "…", "uri": "https://…" }],
  "model": "gemini-3.8-flash"
}
```

Коды ошибок: `401` — токен не передан или неверен, `400` — невалидный промпт либо
запрос отклонён Gemini (`blockReason`), `403` — чужой origin, `405` — не POST,
`429` — исчерпан лимит Gemini, `502` — ошибка upstream, таймаут, пустой/нечитаемый
ответ или отклонённый ключ Gemini, `503` — не задан `ACCESS_TOKEN` или
`GEMINI_API_KEY`. Тело ошибки: `{ "error": "…" }`.

Токен сверяется за постоянное время, в запрос к Gemini не попадает и в логи не
пишется. Проверка origin не заменяет токен: запрос без заголовка `Origin` (curl,
скрипты) проходит, если токен верный.

Worker отклоняет промпт без маркеров методики (`§3.1`, `§19А`, `§20`) — иначе
запрос «оцени эмитента» без методики тихо вернул бы отказ отвечать по ней.

## Лимиты бесплатного тарифа

- Cloudflare Workers Free: 100 000 запросов/сутки. Ожидание сети не входит в
  CPU time (10 мс), wall time HTTP-запроса не ограничен — долгий ответ Gemini укладывается.
- Gemini: 500 запросов с Search grounding в сутки — цифра для поколения 2.5,
  актуальный лимит для 3.x в документации на момент проверки не подтверждён.
