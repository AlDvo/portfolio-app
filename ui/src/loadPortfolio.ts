import XLSX from 'xlsx';
import { calculatePortfolio } from '../../core/calculator.js';
import type { PositionInput } from '../../core/calculator.js';
import { FALLBACK_KEY_RATE_PCT, fetchKeyRatePct, loadOfzCurve, loadSecurity } from '../../core/moex.js';
import { parseBrokerReport } from '../../core/parser.js';
import type { PortfolioMeta } from '../../core/types.js';
import type { Portfolio } from './types.js';

export interface LoadProgress {
  loaded: number;
  total: number;
  /** Текущий этап: имя бумаги или «кривая ОФЗ». */
  name: string;
}

import { delay } from '../../core/utils.js';

/** Ключевая ставка ЦБ: через Vite-proxy /cbr-keyrate (cbr.ru без CORS), иначе резерв. */
const resolveKeyRatePct = async () =>
  (await fetchKeyRatePct('/cbr-keyrate')) ?? FALLBACK_KEY_RATE_PCT;

/**
 * Чтение брокерского отчёта Альфа-Банка (.xlsx) в браузере:
 * парсинг Excel → загрузка данных MOEX по каждой позиции → расчёт портфеля.
 * Повторяется логика CLI (src/index.ts), но без Node-специфичного файлового ввода-вывода.
 */
export async function loadPortfolioFromFile(
  file: File,
  onProgress: (p: LoadProgress) => void,
): Promise<{ meta: PortfolioMeta; portfolio: Portfolio; inputs: PositionInput[]; ofzCurve: any[] }> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const { meta, positions, costs } = parseBrokerReport(wb);

  const keyRatePct = await resolveKeyRatePct();
  const costByIsin = new Map(costs.map((c) => [c.isin, c]));
  const inputs: PositionInput[] = [];
  let loaded = 0;
  const concurrency = 3;
  for (let i = 0; i < positions.length; i += concurrency) {
    const chunk = positions.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (p, idx) => {
        const security = await loadSecurity(p.isin, { keyRatePct });
        return { index: i + idx, p, security };
      }),
    );
    for (const r of results) {
      inputs.push({ row: r.p, cost: costByIsin.get(r.p.isin), security: r.security, ofzCurve: [] });
      loaded++;
      onProgress({ loaded, total: positions.length, name: r.p.name });
    }
    if (i + concurrency < positions.length) {
      await delay(120);
    }
  }

  onProgress({ loaded: positions.length, total: positions.length, name: 'кривая ОФЗ' });
  const ofzCurve = await loadOfzCurve();
  for (const input of inputs) input.ofzCurve = ofzCurve;

  const portfolio = calculatePortfolio(inputs);
  return { meta, portfolio, inputs, ofzCurve };
}