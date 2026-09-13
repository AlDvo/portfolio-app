import type { CouponEvent, OfzPoint, SecurityData } from './types.js';

const ISS_BASE = 'https://iss.moex.com/iss';
const UA = { 'User-Agent': 'portfolio-calc/0.1' };
const DAY = 86400000;

// ── Ключевая ставка ЦБ ─────────────────────────────────────
// Флоатеры без известных купонов: MOEX даёт только COUPON_BENCHMARK (RREFKEYR = КС)
// + COUPON_BENCHMARK_SPREAD. cbr.ru без CORS — в браузере через Vite-proxy /cbr-keyrate.
export const CBR_KEY_RATE_URL = 'https://www.cbr.ru/hd_base/KeyRate/?UniDbQuery.Posted=True';
/** Резервное значение КС (%, годовых) — обновлять вручную при изменении ставки. */
export const FALLBACK_KEY_RATE_PCT = 14.0;

/** Парсит страницу cbr.ru «Решения по ключевой ставке»: первая строка — последнее решение. */
export function parseKeyRateHtml(html: string): number | null {
  const m = /<\s*td[^>]*>\s*(\d{2}\.\d{2}\.\d{4})\s*<\/td>\s*<\s*td[^>]*>\s*([\d,]+)\s*<\/td>/i.exec(html);
  if (!m) return null;
  const v = parseFloat(m[2].replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

let keyRatePromise: Promise<number | null> | null = null;

/** Ключевая ставка ЦБ (%, годовых), кешируется на процесс. null при недоступности. */
export function fetchKeyRatePct(url: string = CBR_KEY_RATE_URL): Promise<number | null> {
  keyRatePromise ??= (async () => {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) return null;
      return parseKeyRateHtml(await r.text());
    } catch {
      return null;
    }
  })();
  return keyRatePromise;
}

/**
 * Синтез купонов флоатера: value = номинал × (КС + спред)/100 × период/365.
 * Известные купоны (value > 0) не трогаем.
 */
export function synthesizeFloatCoupons(
  coupons: CouponEvent[],
  faceValue: number,
  keyRatePct: number,
  spreadPct: number,
  freqPerYear: number,
): CouponEvent[] {
  const annualRatePct = keyRatePct + spreadPct;
  return coupons.map((c) => {
    if (c.value > 0) return c;
    let days: number | null = null;
    if (c.periodStart) {
      const d = Math.round((c.date.getTime() - c.periodStart.getTime()) / DAY);
      if (d > 0) days = d;
    }
    if (days === null && freqPerYear > 0) days = 365 / freqPerYear;
    if (days === null) return c;
    const basis = c.faceAfter > 0 ? c.faceAfter : faceValue;
    const value = Math.round(basis * (annualRatePct / 100) * (days / 365) * 100) / 100;
    return { ...c, value, type: 'float' };
  });
}

const cache = new Map<string, Promise<any>>();

function issUrl(path: string, params: Record<string, string | number> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  return `${ISS_BASE}${path}?${q.toString()}`;
}

function iss(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const url = issUrl(path, params);
  if (!cache.has(url)) {
    cache.set(url, fetch(url, { headers: UA }).then((r) => r.json()));
  }
  return cache.get(url)!;
}

/** Превращает блок {columns, data} в массив объектов. */
function rowsOf(json: any, block: string): Record<string, unknown>[] {
  const b = json[block];
  if (!b || !Array.isArray(b.data)) return [];
  const cols: string[] = b.columns;
  return b.data.map((r: unknown[]) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

/** Превращает description-блок {columns:[name,title,value,...], data} в map name→value. */
function kvOf(json: any, block: string): Record<string, string> {
  const b = json[block];
  if (!b || !Array.isArray(b.data)) return {};
  const out: Record<string, string> = {};
  for (const r of b.data) {
    if (r.length >= 3 && r[0] != null) out[String(r[0])] = String(r[2]);
  }
  return out;
}

function num(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function toDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  const d = new Date(String(v).slice(0, 10));
  return d.getTime() ? d : null;
}

const CURRENCY_MAP: Record<string, string> = { SUR: 'RUB' };

function mapCurrency(c: unknown): string {
  const s = String(c ?? 'RUB');
  return CURRENCY_MAP[s] ?? s;
}

export interface SecurityRef {
  secid: string;
  name: string;
  shortname: string;
  type: string;
  group: string;
  board: string;
}

/** Поиск бумаги по ISIN через поисковый endpoint ISS. */
export async function findSecurityByIsin(isin: string): Promise<SecurityRef | null> {
  const json = await iss('/securities.json', { q: isin, 'iss.meta': 'off' });
  const hits = rowsOf(json, 'securities')
    .filter((r) => String(r.isin ?? r.ISIN ?? r.secid ?? r.SECID ?? '') === isin);
  if (!hits.length) return null;
  // Предпочитаем торгующуюся бумагу (is_traded=1), иначе первую.
  const isTraded = (h: Record<string, unknown>) => Number(h.is_traded ?? h.IS_TRADED ?? 0);
  hits.sort((a, b) => isTraded(b) - isTraded(a) || String(a.SECID ?? a.secid).localeCompare(String(b.SECID ?? b.secid)));
  const h = hits[0];
  return {
    secid: String(h.secid ?? h.SECID ?? ''),
    name: String(h.name ?? h.NAME ?? ''),
    shortname: String(h.shortname ?? h.SHORTNAME ?? ''),
    type: String(h.type ?? h.TYPE ?? ''),
    group: String(h.group ?? h.GROUP ?? ''),
    board: String(h.primary_boardid ?? h.PRIMARY_BOARDID ?? ''),
  };
}

/** Рыночный сегмент для board-эндпоинта. */
function marketFor(group: string): string {
  if (group === 'stock_bonds') return 'bonds';
  if (group === 'stock_shares' || group === 'stock_ppif' || group === 'stock_dr') return 'shares';
  return 'bonds';
}

function securityTypeFor(ref: SecurityRef): SecurityData['securityType'] {
  const t = ref.type;
  const g = ref.group;
  if (t.includes('bond') || g === 'stock_bonds') return 'bond';
  if (g === 'stock_ppif' || t === 'exchange_ppif' || t.includes('ppif') || t.includes('etf')) return 'etf';
  return 'share';
}

/** Загрузка всех данных по бумаге: описание, купоны/амортизации, рынок. */
export async function loadSecurity(isin: string, opts: { keyRatePct?: number } = {}): Promise<SecurityData | null> {
  const ref = await findSecurityByIsin(isin);
  if (!ref || !ref.secid) return null;
  const secid = ref.secid;
  const stype = securityTypeFor(ref);

  let desc: Record<string, string> = {};
  let coupons: Record<string, unknown>[] = [];
  let amortizations: Record<string, unknown>[] = [];
  let offers: Record<string, unknown>[] = [];
  let dividends: Record<string, unknown>[] = [];
  let lastPrice = 0;
  let accruedInt = 0;
  let tradingStatus = '';

  // description (KV) — есть у большинства бумаг, кроме некоторых паёв
  try {
    const d = await iss(`/securities/${secid}.json`, { 'iss.meta': 'off' });
    desc = kvOf(d, 'description');
  } catch {
    /* нет описания — не критично */
  }

  // bondization — купоны и амортизации (у облигаций; у акций/паёв блоки пустые)
  if (stype === 'bond') {
    try {
      const b = await iss(`/securities/${secid}/bondization.json`, { 'iss.meta': 'off', limit: 100 });
      coupons = rowsOf(b, 'coupons');
      amortizations = rowsOf(b, 'amortizations');
      offers = rowsOf(b, 'offers');
    } catch {
      /* нет bondization */
    }
  }

  // рыночные данные: LAST/TRADINGSTATUS из marketdata, ACCRUEDINT из securities-блока
  try {
    const market = marketFor(ref.group);
    const board = ref.board;
    if (board) {
      const md = await iss(`/engines/stock/markets/${market}/boards/${board}/securities/${secid}.json`, { 'iss.meta': 'off' });
      const mdRow = rowsOf(md, 'marketdata')[0] ?? {};
      const secRow = rowsOf(md, 'securities')[0] ?? {};
      lastPrice = num(mdRow.LAST ?? secRow.LAST);
      accruedInt = num(secRow.ACCRUEDINT ?? mdRow.ACCRUEDINT);
      tradingStatus = String(mdRow.TRADINGSTATUS ?? secRow.TRADINGSTATUS ?? '');
    }
  } catch {
    /* нет рыночных данных */
  }

  // дивиденды (блок может отсутствовать в некоторых данных ISS)
  try {
    const dv = await iss(`/securities/${secid}/dividends.json`, { 'iss.meta': 'off' });
    dividends = rowsOf(dv, 'dividends');
  } catch {
    /* нет дивидендов */
  }

  const couponEvents: CouponEvent[] = coupons.map((c) => {
    const d = toDate(c.COUPONDATE ?? c.coupondate);
    const value = num(c.VALUE_RUB ?? c.value_rub ?? c.VALUE ?? c.value);
    const faceAfter = num(c.FACEVALUE ?? c.facevalue) || num(c.INITIALFACEVALUE ?? c.initialfacevalue);
    const isFloat = c.VALUEPRC == null && c.valueprc == null && value > 0;
    const type: CouponEvent['type'] = isFloat ? 'float' : 'fixed';
    return {
      date: d ?? new Date(0),
      value,
      type,
      faceAfter,
      isKnown: value > 0,
      periodStart: toDate(c.STARTDATE ?? c.startdate),
    };
  }).sort((a, b) => a.date.getTime() - b.date.getTime());

  // Флоатер без известных купонов: синтез по COUPON_BENCHMARK + COUPON_BENCHMARK_SPREAD
  const spreadPct = num(desc.COUPON_BENCHMARK_SPREAD);
  const freqPerYear = num(desc.COUPONFREQUENCY);
  const hasKnownCoupon = couponEvents.some((c) => c.isKnown);
  if (
    stype === 'bond' &&
    !hasKnownCoupon &&
    couponEvents.length > 0 &&
    desc.COUPON_BENCHMARK &&
    spreadPct > 0
  ) {
    const keyRatePct = opts.keyRatePct ?? (await fetchKeyRatePct()) ?? FALLBACK_KEY_RATE_PCT;
    const faceValue = num(desc.FACEVALUE ?? desc.INITIALFACEVALUE) || 0;
    couponEvents.splice(0, couponEvents.length, ...synthesizeFloatCoupons(couponEvents, faceValue, keyRatePct, spreadPct, freqPerYear));
  }

  const amortizationEvents = amortizations.map((a) => {
    const d = toDate(a.AMORTDATE ?? a.amortdate);
    const value = num(a.VALUE_RUB ?? a.value_rub ?? a.VALUE ?? a.value);
    const faceAfter = num(a.FACEVALUE ?? a.facevalue) || num(a.INITIALFACEVALUE ?? a.initialfacevalue);
    return { date: d ?? new Date(0), value, faceAfter };
  }).sort((a, b) => a.date.getTime() - b.date.getTime());

  const offerEvents = offers.map((o) => ({
    date: toDate(o.OFFERDATE ?? o.offerdate ?? o.PRICEDATE ?? o.pricedate) ?? new Date(0),
    price: num(o.VALUEPRC ?? o.valueprc ?? o.PRICE ?? o.price),
  }));

  const dividendEvents = dividends
    .filter((dd) => dd.VALUE != null && dd.value != null)
    .map((dd) => ({
      exDate: toDate(dd.REGISTRYCLOSEDATE ?? dd.registryclosedate ?? dd.PAYMENTDATE ?? dd.paymentdate) ?? new Date(0),
      valuePerShare: num(dd.VALUE ?? dd.value),
    }));

  const faceValue = num(desc.FACEVALUE ?? desc.INITIALFACEVALUE) || 0;

  return {
    isin,
    secid,
    name: desc.NAME || ref.name || ref.shortname || isin,
    securityType: stype,
    currency: mapCurrency(desc.FACEUNIT),
    faceValue,
    maturityDate: toDate(desc.MATDATE ?? desc.matdate),
    board: ref.board,
    lastPrice,
    accruedInt,
    tradingStatus,
    coupons: couponEvents,
    offers: offerEvents,
    dividends: dividendEvents,
    amortizations: amortizationEvents,
  };
}

/** Кривая ОФЗ (TQOB, RUB): dюрация (дней→лет) → эффективная доходность %. */
export async function loadOfzCurve(): Promise<OfzPoint[]> {
  const points: OfzPoint[] = [];
  const PAGE = 100;
  for (let start = 0; ; start += PAGE) {
    const json = await iss('/engines/stock/markets/bonds/boards/TQOB/securities.json', {
      'iss.meta': 'off',
      'iss.only': 'securities,marketdata',
      limit: PAGE,
      start,
    });
    const secs = rowsOf(json, 'securities');
    if (!secs.length) break;
    const mds = rowsOf(json, 'marketdata');
    const mdBySecid = new Map(mds.map((m) => [String(m.SECID), m]));
    for (const s of secs) {
      const shortname = String(s.SHORTNAME ?? '');
      if (!shortname.startsWith('ОФЗ')) continue;
      // Считаем только рублёвые ОФЗ: FACEUNIT=RVU/SUR — рублёвый номинал
      const faceUnit = String(s.FACEUNIT ?? '');
      if (faceUnit && !['SUR', 'RUB'].includes(faceUnit)) continue;
      const md = mdBySecid.get(String(s.SECID));
      if (!md) continue;
      const durDays = num(md.DURATION);
      const ytm = num(md.YIELD);
      if (durDays <= 0 || ytm <= 0) continue;
      points.push({
        secid: String(s.SECID),
        shortname,
        durationYears: durDays / 365,
        ytm,
      });
    }
    if (secs.length < PAGE) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  points.sort((a, b) => a.durationYears - b.durationYears);
  return points;
}