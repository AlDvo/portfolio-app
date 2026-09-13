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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
): Promise<{ meta: PortfolioMeta; portfolio: Portfolio }> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const { meta, positions, costs } = parseBrokerReport(wb);

  const keyRatePct = await resolveKeyRatePct();
  const costByIsin = new Map(costs.map((c) => [c.isin, c]));
  const inputs: PositionInput[] = [];
  for (const [i, p] of positions.entries()) {
    onProgress({ loaded: i, total: positions.length, name: p.name });
    const security = await loadSecurity(p.isin, { keyRatePct });
    inputs.push({ row: p, cost: costByIsin.get(p.isin), security, ofzCurve: [] });
    await delay(120); // пауза между запросами к ISS
  }

  onProgress({ loaded: positions.length, total: positions.length, name: 'кривая ОФЗ' });
  const ofzCurve = await loadOfzCurve();
  for (const input of inputs) input.ofzCurve = ofzCurve;

  const portfolio = calculatePortfolio(inputs);
  return { meta, portfolio };
}