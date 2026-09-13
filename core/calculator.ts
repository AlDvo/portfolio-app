import type { CashFlowEvent, CouponEvent, OfzPoint, PortfolioMetrics, PositionCost, PositionMetrics, PositionRow, SecurityData } from './types.js';

const DAY = 86400000;
const YEAR = 365 * DAY;

// ── Утилиты времени ────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / DAY;
}

function yearsBetween(a: Date, b: Date): number {
  return daysBetween(a, b) / 365;
}

function isPast(d: Date, ref: Date): boolean {
  return d.getTime() < ref.getTime();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Денежные потоки облигации ─────────────────────────────

export interface CashFlow {
  date: Date;
  perBond: number;
}

export interface BondFlows {
  flows: CashFlow[];       // все события на 1 бумагу: купоны + амортизации + погашение
  couponSum: number;       // сумма купонных выплат на 1 бумагу
  amortSum: number;        // сумма амортизаций на 1 бумагу
  facePerBond: number;     // остаток номинала к погашению (если не амортизирован)
  assumed: boolean;        // true — есть неизвестные будущие купоны (float_assumption)
}

// ── Last-known coupon с учётом длины купонного периода ─────

export interface KnownCoupon {
  value: number;            // ₽ на бумагу за купонный период
  periodDays: number | null; // длительность купонного периода в днях (null если startdate неизвестен)
}

function periodDaysOf(c: CouponEvent): number | null {
  if (!c.periodStart) return null;
  const days = Math.round((c.date.getTime() - c.periodStart.getTime()) / DAY);
  return days > 0 ? days : null;
}

/**
 * Последний известный купон — база для float_assumption (допущение A8).
 * Возвращает {value, periodDays} — с учётом длительности купонного периода
 * (важно для длинных первых купонов: 35.62 ₽ за 80 дней → масштаб
 * для месячных периодов ≈ 13.8 ₽).
 */
export function lastKnownCoupon(sec: SecurityData): KnownCoupon | null {
  let last: KnownCoupon | null = null;
  for (const c of sec.coupons) {
    if (c.isKnown && c.value > 0) last = { value: c.value, periodDays: periodDaysOf(c) };
  }
  return last;
}

/**
 * Значение купона: известное — как есть; неизвестное — последний известный,
 * скорректированный пропорционально длине купонного периода
 * (спасает длинные первые купоны от завышения).
 * Если периоды неизвестны — без коррекции (fallback на lastKnown.value).
 */
function couponValueFor(c: CouponEvent, last: KnownCoupon | null): number {
  if (c.value > 0) return c.value;
  if (!last || last.value <= 0) return 0;
  const curDays = periodDaysOf(c);
  if (curDays != null && last.periodDays != null && curDays !== last.periodDays) {
    return last.value * (curDays / last.periodDays);
  }
  return last.value;
}

/**
 * Будущие денежные потоки облигации на 1 бумагу от refDate.
 * Неизвестные купоны (флоатер/неопределённые) ≈ последний известный купон — допущение A8.
 */
export function buildBondFlows(sec: SecurityData, refDate: Date): BondFlows {
  const flows: CashFlow[] = [];
  let couponSum = 0;
  let assumed = false;
  const lastKnown = lastKnownCoupon(sec);

  for (const c of sec.coupons) {
    if (isPast(c.date, refDate)) continue;
    const value = couponValueFor(c, lastKnown);
    if (value <= 0) continue;
    if (!(c.isKnown && c.value > 0)) assumed = true;
    flows.push({ date: c.date, perBond: value });
    couponSum += value;
  }

  let amortSum = 0;
  for (const a of sec.amortizations) {
    if (isPast(a.date, refDate)) continue;
    flows.push({ date: a.date, perBond: a.value });
    amortSum += a.value;
  }

  // Остаток номинала, не покрытый амортизациями, гасится в дату погашения
  const facePerBond = Math.max(0, sec.faceValue - amortSum);
  if (facePerBond > 0 && sec.maturityDate && !isPast(sec.maturityDate, refDate)) {
    flows.push({ date: sec.maturityDate, perBond: facePerBond });
  }

  flows.sort((a, b) => a.date.getTime() - b.date.getTime());
  return { flows, couponSum, amortSum, facePerBond, assumed };
}

/** Суммы купонов и амортизаций в окне [refDate, refDate+days]. */
function sumsInWindow(sec: SecurityData, refDate: Date, days: number): { coupons: number; amortizations: number } {
  const limit = refDate.getTime() + days * DAY;
  let coupons = 0;
  let amortizations = 0;
  const lastKnown = lastKnownCoupon(sec);
  for (const c of sec.coupons) {
    if (c.date.getTime() < refDate.getTime() || c.date.getTime() > limit) continue;
    const value = couponValueFor(c, lastKnown);
    if (value > 0) coupons += value;
  }
  for (const a of sec.amortizations) {
    if (a.date.getTime() < refDate.getTime() || a.date.getTime() > limit) continue;
    amortizations += a.value;
  }
  return { coupons, amortizations };
}

// ── YTM, дюрация, G-spread ────────────────────────────────

/** Текущая стоимость потоков при годовой дробной доходности y. */
function npv(flows: CashFlow[], y: number, refDate: Date): number {
  let sum = 0;
  for (const cf of flows) {
    const t = yearsBetween(refDate, cf.date);
    if (t < 0) continue;
    sum += cf.perBond / Math.pow(1 + y, t);
  }
  return sum;
}

/** YTM (дробная годовая доходность) биссекцией на y ∈ [−0.5, 0.999]. */
export function bisectYtm(flows: CashFlow[], dirty: number, refDate: Date): number | null {
  const future = flows.filter((cf) => !isPast(cf.date, refDate));
  if (!future.length || dirty <= 0) return null;
  const MIN_Y = -0.5;
  const MAX_Y = 0.999;
  let lo = MIN_Y;
  let hi = MAX_Y;
  let fLo = npv(future, lo, refDate) - dirty;
  const fHi = npv(future, hi, refDate) - dirty;
  if (fLo * fHi > 0) return null; // корня в диапазоне нет
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(future, mid, refDate) - dirty;
    if (Math.abs(fMid) < 1e-9) return mid;
    if (fLo * fMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/** Дюрация Маколея в годах. */
export function macaulayYears(flows: CashFlow[], y: number, refDate: Date): number {
  let num = 0;
  let den = 0;
  for (const cf of flows) {
    const t = yearsBetween(refDate, cf.date);
    if (t < 0) continue;
    const pv = cf.perBond / Math.pow(1 + y, t);
    num += t * pv;
    den += pv;
  }
  return den > 0 ? num / den : 0;
}

/**
 * G-spread: YTM бонда − YTM бенчмарка (линейная интерполяция ОФЗ-кривой).
 * Вне диапазона кривой → null (спека 5.6).
 */
export function gSpreadInterp(ytmPct: number, durYears: number, curve: OfzPoint[]): number | null {
  if (!curve.length || durYears <= 0 || ytmPct <= 0) return null;
  const first = curve[0];
  const last  = curve[curve.length - 1];
  if (durYears < first.durationYears || durYears > last.durationYears) return null;
  for (let i = 0; i < curve.length - 1; i++) {
    const lo = curve[i];
    const hi = curve[i + 1];
    if (durYears >= lo.durationYears && durYears <= hi.durationYears) {
      const span = hi.durationYears - lo.durationYears;
      if (span === 0) return ytmPct - lo.ytm;
      const t = (durYears - lo.durationYears) / span;
      const benchYtm = lo.ytm + t * (hi.ytm - lo.ytm);
      return ytmPct - benchYtm;
    }
  }
  return null;
}

// ── Статусы ───────────────────────────────────────────────

const STATUS_ORDER: PositionMetrics['status'][] = ['not_found', 'delisted', 'no_data', 'float_assumption', 'ok'];

function statusPriority(s: PositionMetrics['status']): number {
  const i = STATUS_ORDER.indexOf(s);
  return i < 0 ? 0 : i;
}

/** Худший (приоритетный) статус из списка. */
export function pickStatus(cands: PositionMetrics['status'][]): PositionMetrics['status'] {
  let worst: PositionMetrics['status'] = 'ok';
  let worstP = Infinity;
  for (const c of cands) {
    const p = statusPriority(c);
    if (p < worstP) {
      worstP = p;
      worst = c;
    }
  }
  return worst;
}

// ── Расчёт ────────────────────────────────────────────────

export interface PositionInput {
  row: PositionRow;
  cost?: PositionCost;
  security: SecurityData | null;
  ofzCurve: OfzPoint[];
}

export function calculatePortfolio(input: PositionInput[]): PortfolioMetrics {
  const refDate = new Date();
  const positions: PositionMetrics[] = [];

  for (const { row, cost, security, ofzCurve } of input) {
    const qty = row.quantityEnd;
    const buyQty = cost?.buyQty ?? 0;
    const avgPriceNet = buyQty > 0 ? cost!.buyCost / buyQty : 0;

    let securityType: PositionMetrics['securityType'];
    let lastPrice = 0;
    let accruedInt = 0;
    let currency = 'RUB';
    let status: PositionMetrics['status'] = 'ok';

    if (!security) {
      status = 'not_found';
      securityType = row.category === 'Акции' ? 'share' : 'bond';
    } else {
      securityType = security.securityType;
      lastPrice = security.lastPrice;
      accruedInt = security.accruedInt;
      currency = security.currency;
      if (!security.tradingStatus) {
        status = 'no_data';
      } else if (security.tradingStatus !== 'N') {
        status = 'delisted';
      }
    }

    // Себестоимость: цена облигаций в отчёте — % от номинала (как на MOEX),
    // поэтому переводим в рубли через faceValue/100; акции/фонды — сразу рубли.
    const faceMult = security && securityType === 'bond' && security.faceValue > 0 ? security.faceValue / 100 : 1;
    const avgCostPerUnit = buyQty > 0 ? (cost!.buyCost * faceMult + cost!.buyNkd + cost!.buyFee) / buyQty : 0;
    const costBasis = avgCostPerUnit > 0 ? avgCostPerUnit * qty : row.valueEnd;

    // Рыночная стоимость: облигации — % от номинала + НКД; акции/фонды — цена × кол-во
    let marketValueFull: number;
    if (security && securityType === 'bond' && security.faceValue > 0) {
      marketValueFull = qty * (security.faceValue * lastPrice / 100 + accruedInt);
    } else if (security && lastPrice > 0) {
      marketValueFull = qty * lastPrice;
    } else {
      marketValueFull = row.valueEnd; // fallback на оценку брокера
    }
    const pnl = marketValueFull - costBasis;
    const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

    // ── Облигации ──
    let couponYieldCurrent = 0;
    let couponYieldSimpleToMaturity = 0;
    let ytmMarket = 0;
    let ytmFromPurchase = 0;
    let ytpFromPurchase: number | null = null;
    let durationMacaulay = 0;
    let durationModified = 0;
    let dv01 = 0;
    let gSpread: number | null = null;
    const cashFlowToMaturity = { coupons: 0, amortization: 0, face: 0, total: 0 };
    let incomeNext12m = 0;
    let dividendYieldTtm = 0;
    let dividendIncomeYear = 0;

    if (security && securityType === 'bond') {
      const bundle = buildBondFlows(security, refDate);
      const dirtyPerBond = security.faceValue * lastPrice / 100 + accruedInt;

      // Текущая купонная доходность: купоны за 12 мес / рыночная стоимость
      const twelve = sumsInWindow(security, refDate, 365);
      couponYieldCurrent = marketValueFull > 0 ? (twelve.coupons * qty / marketValueFull) * 100 : 0;
      incomeNext12m = (twelve.coupons + twelve.amortizations) * qty;

      // YTM к погашению по рыночной цене
      const ytm = lastPrice > 0 ? bisectYtm(bundle.flows, dirtyPerBond, refDate) : null;
      if (ytm != null) {
        ytmMarket = ytm * 100;
        durationMacaulay = macaulayYears(bundle.flows, ytm, refDate);
        durationModified = 1 + ytm > 0 ? durationMacaulay / (1 + ytm) : 0;
        dv01 = 0.0001 * durationModified * marketValueFull;
        gSpread = gSpreadInterp(ytmMarket, durationMacaulay, ofzCurve);
      } else if (lastPrice > 0) {
        status = pickStatus([status, 'no_data']);
      }

      cashFlowToMaturity.coupons = bundle.couponSum * qty;
      cashFlowToMaturity.amortization = bundle.amortSum * qty;
      cashFlowToMaturity.face = bundle.facePerBond * qty;
      cashFlowToMaturity.total = (bundle.couponSum + bundle.amortSum + bundle.facePerBond) * qty;

      // Простая доходность к погашению
      const yearsToMat = security.maturityDate && !isPast(security.maturityDate, refDate)
        ? yearsBetween(refDate, security.maturityDate)
        : 0;
      if (yearsToMat > 0 && dirtyPerBond > 0) {
        const totalPerBond = bundle.couponSum + bundle.amortSum + bundle.facePerBond;
        couponYieldSimpleToMaturity = ((totalPerBond - dirtyPerBond) / dirtyPerBond) / yearsToMat * 100;
      }

      // YTM от цены покупки (средняя цена + НКД на момент покупки)
      const purchaseDirty = avgPriceNet > 0 ? avgPriceNet * faceMult + (cost?.buyNkd ?? 0) / Math.max(1, buyQty) : 0;
      if (purchaseDirty > 0 && bundle.flows.length) {
        const ytmBuy = bisectYtm(bundle.flows, purchaseDirty, refDate);
        if (ytmBuy != null) ytmFromPurchase = ytmBuy * 100;
      }

      // YTP: доходность к ближайшей будущей оферте от цены покупки
      const offer = security.offers
        .filter((o) => !isPast(o.date, refDate) && o.date.getTime() - refDate.getTime() > 7 * DAY && o.price > 0)
        .sort((a, b) => a.date.getTime() - b.date.getTime())[0];
      if (offer && purchaseDirty > 0) {
        const flowsToOffer = bundle.flows.filter((cf) => cf.date.getTime() <= offer.date.getTime());
        flowsToOffer.push({ date: offer.date, perBond: security.faceValue * offer.price / 100 });
        const ytp = bisectYtm(flowsToOffer, purchaseDirty, refDate);
        if (ytp != null) ytpFromPurchase = ytp * 100;
      }

      if (bundle.assumed) status = pickStatus([status, 'float_assumption']);
    }

    // ── Акции / фонды ──
    if (security && securityType !== 'bond' && lastPrice > 0) {
      const yearAgo = new Date(refDate.getTime() - YEAR);
      let perShare = 0;
      for (const d of security.dividends) {
        if (d.exDate.getTime() >= yearAgo.getTime() && d.exDate.getTime() <= refDate.getTime()) {
          perShare += d.valuePerShare;
        }
      }
      dividendYieldTtm = (perShare / lastPrice) * 100;
      dividendIncomeYear = perShare * qty;
      incomeNext12m = dividendIncomeYear;
    }

    positions.push({
      isin: row.isin,
      name: security?.name ?? row.name,
      securityType,
      quantity: qty,
      avgPriceNet,
      currency,
      lastPrice,
      accruedInt,
      marketValueFull,
      costBasis,
      pnl,
      pnlPercent,
      weight: 0,
      couponYieldCurrent,
      couponYieldSimpleToMaturity,
      ytmMarket,
      ytmFromPurchase,
      ytpFromPurchase,
      durationMacaulay,
      durationModified,
      dv01,
      gSpread,
      dividendYieldTtm,
      dividendIncomeYear,
      cashFlowToMaturity,
      incomeNext12m,
      status,
    });
  }

  const totalValue = positions.reduce((s, p) => s + p.marketValueFull, 0);
  const totalCost = positions.reduce((s, p) => s + p.costBasis, 0);
  for (const p of positions) p.weight = totalValue > 0 ? (p.marketValueFull / totalValue) * 100 : 0;

  const weightsByType = { bonds: 0, shares: 0, etf: 0 };
  for (const p of positions) {
    if (p.securityType === 'bond') weightsByType.bonds += p.marketValueFull;
    else if (p.securityType === 'share') weightsByType.shares += p.marketValueFull;
    else weightsByType.etf += p.marketValueFull;
  }
  for (const k of Object.keys(weightsByType) as (keyof typeof weightsByType)[]) {
    weightsByType[k] = totalValue > 0 ? (weightsByType[k] / totalValue) * 100 : 0;
  }

  const bondsOnly = positions.filter((p) => p.securityType === 'bond' && p.ytmMarket > 0);
  const bondsValue = bondsOnly.reduce((s, p) => s + p.marketValueFull, 0);
  const weightedDuration = totalValue > 0
    ? positions.reduce((s, p) => s + p.durationMacaulay * p.marketValueFull, 0) / totalValue
    : 0;
  const portfolioDv01 = positions.reduce((s, p) => s + p.dv01, 0);
  const avgYtmBonds = bondsValue > 0 ? bondsOnly.reduce((s, p) => s + p.ytmMarket * p.marketValueFull, 0) / bondsValue : 0;

  const couponIncome12m = positions.filter((p) => p.securityType === 'bond').reduce((s, p) => s + p.incomeNext12m, 0);
  const dividendIncome12m = positions.filter((p) => p.securityType !== 'bond').reduce((s, p) => s + p.incomeNext12m, 0);
  const totalIncome12m = couponIncome12m + dividendIncome12m;
  const totalIncome12mPercent = totalValue > 0 ? (totalIncome12m / totalValue) * 100 : 0;

  // ── Календарь денежных потоков ──
  const cashFlowCalendar: CashFlowEvent[] = [];
  for (const { row, security } of input) {
    if (!security) continue;
    const qty = row.quantityEnd;

    if (security.securityType === 'bond') {
      const lastKnown = lastKnownCoupon(security);
      const maturity = security.maturityDate;

      for (const c of security.coupons) {
        if (isPast(c.date, refDate)) continue;
        const value = couponValueFor(c, lastKnown);
        if (value <= 0) continue;
        cashFlowCalendar.push({ date: isoDate(c.date), isin: row.isin, name: security.name, type: 'coupon', amount: value * qty });
      }
      for (const a of security.amortizations) {
        if (isPast(a.date, refDate) || a.value <= 0) continue;
        const isMaturity = maturity && a.date.getTime() === maturity.getTime();
        cashFlowCalendar.push({ date: isoDate(a.date), isin: row.isin, name: security.name, type: isMaturity ? 'maturity' : 'amortization', amount: a.value * qty });
      }
      // Остаток номинала, если погашение не покрыто амортизацией
      const amortSum = security.amortizations.reduce((s, a) => s + a.value, 0);
      const facePerBond = Math.max(0, security.faceValue - amortSum);
      if (facePerBond > 0 && maturity && !isPast(maturity, refDate)) {
        cashFlowCalendar.push({ date: isoDate(maturity), isin: row.isin, name: security.name, type: 'maturity', amount: facePerBond * qty });
      }
    } else {
      for (const d of security.dividends) {
        if (isPast(d.exDate, refDate) || d.valuePerShare <= 0) continue;
        cashFlowCalendar.push({ date: isoDate(d.exDate), isin: row.isin, name: security.name, type: 'dividend', amount: d.valuePerShare * qty });
      }
    }
  }
  cashFlowCalendar.sort((a, b) => a.date.localeCompare(b.date));

  const flowByMonth = new Map<string, number>();
  for (const cf of cashFlowCalendar) {
    const month = cf.date.slice(0, 7); // YYYY-MM
    flowByMonth.set(month, (flowByMonth.get(month) ?? 0) + cf.amount);
  }
  const cashFlowByMonth = [...flowByMonth.entries()]
    .map(([month, amount]) => ({ month, amount }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    totalValue,
    totalCost,
    pnlTotal: totalValue - totalCost,
    pnlPercentTotal: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
    positions,
    weightsByType,
    weightedDuration,
    portfolioDv01,
    avgYtmBonds,
    couponIncome12m,
    dividendIncome12m,
    totalIncome12m,
    totalIncome12mPercent,
    cashFlowCalendar,
    cashFlowByMonth,
  };
}