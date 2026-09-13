# UI — дашборд портфеля

React + Vite + TypeScript SPA. Читает брокерский отчёт Альфа-Банка (.xlsx) прямо в браузере
и отображает:

- сводные карточки (стоимость, P/L, дюрация, YTM, доход за 12 мес, структура);
- таблицу позиций с сортировкой по клику на заголовок;
- бар-чарт денежных потоков по месяцам (чистый CSS, без библиотек) с попапом по клику на столбец;
- список ближайших выплат (купон / амортизация / погашение / дивиденды);
- предупреждения по позициям (не найдена / не торгуется / допущение по купону).

## Запуск

```bash
npm install
npm run dev        # dev-сервер, http://localhost:5173
npm run build      # production-сборка в dist/
npm run preview    # просмотр production-сборки
```

## Данные

- На старте — экран выбора файла: перетащите или выберите `.xlsx`-отчёт («Брокерский … (период).xlsx»
  из Альфа-Инвестиций). Файл читается локально (`FileReader` → `XLSX.read`), позиции обогащаются
  данными MOEX ISS напрямую из браузера (CORS у ISS открыт), прогресс показывается на экране.
- Кнопка «Или загрузить демо-данные» читает `public/portfolio.json` (см. ниже).
- Кнопка «Другой файл…» в шапке возвращает к экрану выбора.

## Регенерация демо-данных

JSON создаётся CLI-прототипом из корня репозитория:

```bash
cd ..                # корень example_app
npx tsx src/index.ts --json out/portfolio.json
copy out\portfolio.json ui\public\portfolio.json
```

После этого обновится страница (dev) или требуется пересобрать `npm run build`.

> Если после копирования в dev-режиме данные не появились — `public/portfolio.json`
> отдаётся Vite без кеш-бастионов; достаточно обновить страницу. Для production
> артефакта JSON попадает в `dist/` при сборке.

## Структура

```
ui/
  public/portfolio.json   — демо-данные (генерируются CLI)
  src/
    types.ts              — контракт, реэкспорт типов из ../core
    App.tsx               — стейт загрузки/ошибки/дашборд, шапка, карточки, layout
    UploadPanel.tsx       — экран выбора файла (drag&drop + input + демо)
    loadPortfolio.ts      — Excel → MOEX → calculatePortfolio в браузере
    PositionsTable.tsx    — сортируемая таблица позиций
    CashFlowChart.tsx     — бар-чарт потоков по месяцам + попап
    PayoutsList.tsx       — ближайшие выплаты
    WarningsList.tsx      — предупреждения по статусам позиций
    App.css / index.css   — стили
```

Расчётное ядро общее с CLI — папка `../core` в корне репозитория
(`types.ts`, `parser.ts`, `moex.ts`, `calculator.ts`). Парсер принимает `XLSX.WorkBook`,
файл читает вызывающая сторона: Node (`XLSX.readFile`) или браузер (`XLSX.read`).

## Замечания по сборке

- Vite закреплён на **v6** (`^6.3.5`): v7+ использует rolldown, чьи нативные
  бинарники не ставятся на Windows + Node 20 (ошибка «Cannot find native
  binding»). Не поднимайте Vite до v7/v8 в этом окружении без смены рантайма.
- SheetJS `xlsx` в `vite.config.ts` алиасится на CJS-сборку (`xlsx/xlsx.js`):
  ESM-обёртка (`xlsx.mjs`) не имеет default-экспорта, а единый `import XLSX from 'xlsx'`
  нужен, чтобы ядро работало и в Node (tsx), и в браузере (Rollup/commonjs).
- TypeScript `~5.9.3` — флаги `verbatimModuleSyntax`, `erasableSyntaxOnly`
  требуют >= 5.8, но фичи 6.x не нужны.