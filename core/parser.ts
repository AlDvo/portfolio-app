import XLSX from 'xlsx';
import type { PortfolioMeta, PositionRow, PositionCost } from './types.js';

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const CATEGORIES = new Set(['Акции', 'Облигации', 'Прочее']);
const SUP_DIGITS_RE = /[⁰¹²³⁴⁵⁶⁷⁸⁹]/g;

type Cell = string | number | null;
type Row = Cell[];

function rowsOf(ws: XLSX.WorkSheet): Row[] {
  return XLSX.utils.sheet_to_json<Row>(ws, { header: 1, raw: true, defval: null });
}

function cell(row: Row, idx: number): unknown {
  return row !== undefined && idx < row.length ? row[idx] : null;
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[\s\u00a0]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function normHeader(v: unknown): string {
  return str(v).replace(/\s+/g, '').replace(SUP_DIGITS_RE, '');
}

function findSheet(wb: XLSX.WorkBook, key: string, exact: string): XLSX.WorkSheet {
  const name = wb.SheetNames.find((n) => n.includes(key));
  const ws = name ? wb.Sheets[name] : wb.Sheets[exact];
  if (!ws) throw new Error(`Лист не найден: ${key}`);
  return ws;
}

function parseMeta(rows: Row[]): PortfolioMeta {
  const labels = ['Отчетный период', 'Клиент', 'Ген. соглашение'];
  const found: Record<string, string> = {};
  for (const row of rows.slice(0, 10)) {
    for (const label of labels) {
      if (found[label]) continue;
      const idx = row.findIndex((v) => str(v).includes(label));
      if (idx >= 0) {
        for (let i = idx + 1; i < row.length; i++) {
          if (str(row[i])) {
            found[label] = str(row[i]);
            break;
          }
        }
      }
    }
  }
  const period = found['Отчетный период'] || '';
  const [start = '', end = ''] = period.split('-').map((s) => s.trim());

  let accountType: PortfolioMeta['accountType'] = 'regular';
  const iisRe = /инвестиционный\s+счёт|ИИС/i;
  for (const row of rows.slice(0, 20)) {
    if (row.some((v) => iisRe.test(str(v)))) {
      accountType = 'iis';
      break;
    }
  }

  return {
    reportPeriodStart: start,
    reportPeriodEnd: end,
    client: found['Клиент'] || '',
    agreement: found['Ген. соглашение'] || '',
    accountType,
  };
}

function parsePositions(rows: Row[]): PositionRow[] {
  const positions: PositionRow[] = [];
  let currentCategory: PositionRow['category'] = 'Прочее';
  for (const row of rows) {
    const category = str(cell(row, 0));
    const name = str(cell(row, 4));
    const qtyN = num(cell(row, 13));
    if (name.includes('Стоимость всех позиций')) break;
    if (name && ISIN_RE.test(name)) {
      if (positions.length && !positions[positions.length - 1].isin) {
        positions[positions.length - 1].isin = name;
      }
      continue;
    }
    if (CATEGORIES.has(category)) {
      currentCategory = category as PositionRow['category'];
    }
    const hasCategory = CATEGORIES.has(category);
    const isContinuation = !category && qtyN > 0 && name;
    if (hasCategory || isContinuation) {
      positions.push({
        isin: '',
        name,
        category: currentCategory,
        quantityEnd: qtyN,
        valueEnd: num(cell(row, 15)),
      });
    }
  }
  return positions.filter((p) => p.isin);
}

interface ColMap {
  isin: number;
  name: number;
  qty: number;
  price: number;
  sum: number;
  nkd: number;
  currency: number;
  fee: number;
}

const ALFA_FALLBACK_COLMAP: ColMap = {
  isin: 12,
  name: 14,
  qty: 16,
  price: 18,
  sum: 19,
  nkd: 21,
  currency: 23,
  fee: 24,
};

function buildColMap(headerRow: Row): ColMap | null {
  const norm: Record<string, number> = {};
  headerRow.forEach((v, i) => {
    const n = normHeader(v);
    if (!n) return;
    if (n.includes('ISIN')) norm.isin = i;
    else if (n.includes('Актив')) norm.name = i;
    else if (n.includes('Количество')) norm.qty = i;
    else if (n === 'Цена') norm.price = i;
    else if (n.includes('Сумма') && n.includes('сделки')) norm.sum = i;
    else if (n.includes('НКД')) norm.nkd = i;
    else if (n.includes('Валюта') && n.includes('расчетов')) norm.currency = i;
    else if (n.includes('Комиссия') && n.includes('банка')) norm.fee = i;
  });
  if (norm.isin === undefined || norm.qty === undefined || norm.price === undefined) {
    return null;
  }
  return {
    isin: norm.isin,
    name: norm.name ?? -1,
    qty: norm.qty,
    price: norm.price,
    sum: norm.sum ?? -1,
    nkd: norm.nkd ?? -1,
    currency: norm.currency ?? -1,
    fee: norm.fee ?? -1,
  };
}

function parseTrades(rows: Row[]): PositionCost[] {
  let headerIdx = -1;
  let colmap: ColMap | null = null;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    if (rows[i].some((v) => normHeader(v).includes('ISIN'))) {
      colmap = buildColMap(rows[i]);
      if (colmap) {
        headerIdx = i;
        break;
      }
    }
  }
  if (headerIdx < 0 || !colmap) {
    colmap = ALFA_FALLBACK_COLMAP;
    headerIdx = 14;
  }

  const acc = new Map<string, PositionCost>();
  for (const row of rows.slice(headerIdx + 1)) {
    const isin = str(cell(row, colmap.isin));
    if (!ISIN_RE.test(isin)) continue;
    const qty = num(cell(row, colmap.qty));
    if (qty === 0) continue;
    const price = num(cell(row, colmap.price));
    const nkd = num(cell(row, colmap.nkd));
    const fee = num(cell(row, colmap.fee));
    let c = acc.get(isin);
    if (!c) {
      c = {
        isin,
        name: colmap.name >= 0 ? str(cell(row, colmap.name)) : '',
        buyQty: 0,
        buyCost: 0,
        buyNkd: 0,
        buyFee: 0,
        netQty: 0,
      };
      acc.set(isin, c);
    }
    c.netQty += qty;
    if (qty > 0) {
      c.buyQty += qty;
      c.buyCost += price * qty;
      c.buyNkd += nkd;
      c.buyFee += fee;
    }
  }
  return [...acc.values()];
}

export function parseBrokerReport(wb: XLSX.WorkBook): { meta: PortfolioMeta; positions: PositionRow[]; costs: PositionCost[] } {
  const posRows = rowsOf(findSheet(wb, 'Динамика', 'Динамика позиций'));
  const meta = parseMeta(posRows);
  const positions = parsePositions(posRows);

  const tradeRows = rowsOf(findSheet(wb, 'Завершен', 'Завершенные сделки'));
  const costs = parseTrades(tradeRows);

  const nameByIsin = new Map(positions.map((p) => [p.isin, p.name]));
  for (const c of costs) {
    if (!c.name) c.name = nameByIsin.get(c.isin) ?? c.isin;
  }

  return { meta, positions, costs };
}