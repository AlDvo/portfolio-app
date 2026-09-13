import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OfzPoint, PositionRow, SecurityData } from '../core/types.js';
import {
  bisectYtm,
  buildBondFlows,
  calculatePortfolio,
  gSpreadInterp,
  lastKnownCoupon,
  macaulayYears,
  pickStatus,
} from '../core/calculator.js';
import type { CashFlow, PositionInput } from '../core/calculator.js';
import { parseKeyRateHtml, synthesizeFloatCoupons } from '../core/moex.js';
import type { CouponEvent } from '../core/types.js';

const DAY = 86400000;
const dt = (base: Date, days: number) => new Date(base.getTime() + days * DAY);
const REF = new Date('2026-01-01T00:00:00Z');

// ── YTM ────────────────────────────────────────────────────

describe('bisectYtm', () => {
  it('zero-coupon: dirty=100, выплата 110 через год → ytm = 0.10', () => {
    const flows: CashFlow[] = [{ date: dt(REF, 365), perBond: 110 }];
    const y = bisectYtm(flows, 100, REF);
    assert.ok(y !== null);
    assert.ok(Math.abs(y - 0.1) < 1e-9);
  });

  it('пар-бонд 10% годовых на 2 года → ytm ≈ 10%', () => {
    const flows: CashFlow[] = [
      { date: dt(REF, 365), perBond: 10 },
      { date: dt(REF, 730), perBond: 110 },
    ];
    const y = bisectYtm(flows, 100, REF);
    assert.ok(y !== null);
    assert.ok(Math.abs(y - 0.1) < 1e-6);
  });

  it('корня нет: все future-потоки меньше dirty → null', () => {
    const flows: CashFlow[] = [{ date: dt(REF, 365), perBond: 50 }];
    assert.equal(bisectYtm(flows, 200, REF), null);
  });

  it('dirty <= 0 → null', () => {
    const flows: CashFlow[] = [{ date: dt(REF, 365), perBond: 110 }];
    assert.equal(bisectYtm(flows, 0, REF), null);
    assert.equal(bisectYtm(flows, -5, REF), null);
  });

  it('нет будущих потоков → null', () => {
    const flows: CashFlow[] = [{ date: dt(REF, -365), perBond: 110 }];
    assert.equal(bisectYtm(flows, 100, REF), null);
  });
});

// ── Дюрация ────────────────────────────────────────────────

describe('macaulayYears', () => {
  it('зеро-купон 2 года → дюрация = 2', () => {
    const flows: CashFlow[] = [{ date: dt(REF, 730), perBond: 100 }];
    const d = macaulayYears(flows, 0.1, REF);
    assert.ok(Math.abs(d - 2) < 1e-12);
  });

  it('пар-бонд 10% годовых на 2 года → дюрация ≈ 1.9091', () => {
    const flows: CashFlow[] = [
      { date: dt(REF, 365), perBond: 10 },
      { date: dt(REF, 730), perBond: 110 },
    ];
    const d = macaulayYears(flows, 0.1, REF);
    const expected = (10 / 1.1 * 1 + 110 / 1.21 * 2) / (10 / 1.1 + 110 / 1.21);
    assert.ok(Math.abs(d - expected) < 1e-9);
  });

  it('пустые потоки → 0', () => {
    assert.equal(macaulayYears([], 0.1, REF), 0);
  });
});

// ── G-spread ───────────────────────────────────────────────

describe('gSpreadInterp', () => {
  const curve: OfzPoint[] = [
    { secid: 'OFZ1', shortname: '', durationYears: 1, ytm: 5 },
    { secid: 'OFZ2', shortname: '', durationYears: 3, ytm: 7 },
  ];

  it('линейная интерполяция между точками: dur=2 → bench 6 → spread 14', () => {
    assert.equal(gSpreadInterp(20, 2, curve), 14);
  });

  it('в точности на концах кривой', () => {
    assert.equal(gSpreadInterp(20, 1, curve), 15);
    assert.equal(gSpreadInterp(20, 3, curve), 13);
  });

  it('вне диапазона кривой → null', () => {
    assert.equal(gSpreadInterp(20, 0.5, curve), null);
    assert.equal(gSpreadInterp(20, 3.5, curve), null);
  });

  it('пустая кривая или неположительные входы → null', () => {
    assert.equal(gSpreadInterp(20, 2, []), null);
    assert.equal(gSpreadInterp(0, 2, curve), null);
    assert.equal(gSpreadInterp(-1, 2, curve), null);
    assert.equal(gSpreadInterp(20, 0, curve), null);
  });

  it('дегенеративный span (две точки с одинаковой дюрацией) → ytm нижней', () => {
    const dup: OfzPoint[] = [
      { secid: 'A', shortname: '', durationYears: 1, ytm: 5 },
      { secid: 'B', shortname: '', durationYears: 1, ytm: 8 },
    ];
    assert.equal(gSpreadInterp(20, 1, dup), 15);
  });
});

// ── Статусы ────────────────────────────────────────────────

describe('pickStatus', () => {
  it('выбирает самый серьёзный статус', () => {
    assert.equal(pickStatus(['ok', 'float_assumption']), 'float_assumption');
    assert.equal(pickStatus(['float_assumption', 'no_data']), 'no_data');
    assert.equal(pickStatus(['no_data', 'delisted']), 'delisted');
    assert.equal(pickStatus(['delisted', 'not_found']), 'not_found');
  });

  it('только ok → ok', () => {
    assert.equal(pickStatus(['ok', 'ok']), 'ok');
  });

  it('пустой список → ok', () => {
    assert.equal(pickStatus([]), 'ok');
  });
});

// ── Денежные потоки облигации ─────────────────────────────

describe('buildBondFlows', () => {
  const base: SecurityData = {
    isin: 'RU000A0TEST1',
    secid: 'TEST1',
    name: 'Тест',
    securityType: 'bond',
    currency: 'RUB',
    faceValue: 1000,
    maturityDate: dt(REF, 365 * 3),
    board: 'TQCB',
    lastPrice: 100,
    accruedInt: 0,
    tradingStatus: 'N',
    coupons: [
      { date: dt(REF, 365), value: 100, type: 'fixed', faceAfter: 1000, isKnown: true, periodStart: null },
      { date: dt(REF, 365 * 2), value: 100, type: 'fixed', faceAfter: 1000, isKnown: true, periodStart: null },
    ],
    offers: [],
    dividends: [],
    amortizations: [
      { date: dt(REF, 365), value: 200, faceAfter: 800 },
      { date: dt(REF, 365 * 2), value: 300, faceAfter: 500 },
    ],
  };

  it('купоны + амортизации + остаток номинала на погашение', () => {
    const b = buildBondFlows(base, REF);
    assert.equal(b.couponSum, 200);
    assert.equal(b.amortSum, 500);
    assert.equal(b.facePerBond, 500);
    assert.equal(b.assumed, false);
    assert.deepEqual(
      b.flows.map((f) => [f.date.getTime(), f.perBond]),
      [
        [dt(REF, 365).getTime(), 100],
        [dt(REF, 365).getTime(), 200],
        [dt(REF, 730).getTime(), 100],
        [dt(REF, 730).getTime(), 300],
        [dt(REF, 1095).getTime(), 500],
      ],
    );
  });

  it('пропускает прошлые события; погашение остаётся', () => {
    const sec: SecurityData = {
      ...base,
      coupons: [{ date: dt(REF, -100), value: 100, type: 'fixed', faceAfter: 1000, isKnown: true, periodStart: null }],
      amortizations: [{ date: dt(REF, -100), value: 100, faceAfter: 900 }],
      maturityDate: dt(REF, 365),
    };
    const b = buildBondFlows(sec, REF);
    assert.equal(b.couponSum, 0);
    assert.equal(b.amortSum, 0);
    assert.equal(b.facePerBond, 1000);
    assert.equal(b.flows.length, 1);
    assert.equal(b.flows[0].perBond, 1000);
  });

it('float: неизвестный будущий купон = последний известный, assumed=true', () => {
    const sec: SecurityData = {
      ...base,
      coupons: [
        { date: dt(REF, 365), value: 80, type: 'fixed', faceAfter: 1000, isKnown: true, periodStart: null },
        { date: dt(REF, 365 * 2), value: 0, type: 'float', faceAfter: 1000, isKnown: false, periodStart: null },
      ],
      amortizations: [],
    };
    const b = buildBondFlows(sec, REF);
    assert.equal(b.assumed, true);
    assert.equal(b.couponSum, 160);
    assert.deepEqual(lastKnownCoupon(sec), { value: 80, periodDays: null });
  });

  it('float: длинный первый купон масштабируется на длину купонного периода', () => {
    const sec: SecurityData = {
      ...base,
      coupons: [
        { date: dt(REF, 80), value: 35.62, type: 'fixed', faceAfter: 1000, isKnown: true, periodStart: dt(REF, 0) },
        { date: dt(REF, 111), value: 0, type: 'float', faceAfter: 1000, isKnown: false, periodStart: dt(REF, 80) },
        { date: dt(REF, 142), value: 0, type: 'float', faceAfter: 1000, isKnown: false, periodStart: dt(REF, 111) },
      ],
      amortizations: [],
    };
    const b = buildBondFlows(sec, REF);
    assert.equal(b.assumed, true);
    assert.deepEqual(lastKnownCoupon(sec), { value: 35.62, periodDays: 80 });
    const expectedMonthly = 35.62 * (31 / 80);
    assert.ok(Math.abs(b.flows[0].perBond - 35.62) < 1e-9);
    assert.ok(Math.abs(b.flows[1].perBond - expectedMonthly) < 1e-9);
    assert.ok(Math.abs(b.flows[2].perBond - expectedMonthly) < 1e-9);
  });

  it('синтезированный флоатер (value>0, isKnown=false) попадает в потоки и помечается assumed', () => {
    const sec: SecurityData = {
      ...base,
      coupons: [
        { date: dt(REF, 30), value: 14.38, type: 'float', faceAfter: 1000, isKnown: false, periodStart: dt(REF, 0) },
        { date: dt(REF, 60), value: 14.38, type: 'float', faceAfter: 1000, isKnown: false, periodStart: dt(REF, 30) },
      ],
      amortizations: [],
    };
    const b = buildBondFlows(sec, REF);
    assert.equal(b.assumed, true);
    assert.equal(b.couponSum, 28.76);
    const flowDates = b.flows.map((f) => f.date.getTime());
    assert.equal(flowDates.length, 3); // 2 купона + погашение
    assert.ok(flowDates[0] === dt(REF, 30).getTime());
    assert.ok(flowDates[1] === dt(REF, 60).getTime());
    assert.ok(flowDates[2] === dt(REF, 1095).getTime()); // погашение через 3 года
  });
});

// ── calculatePortfolio: интеграция ─────────────────────────

describe('calculatePortfolio', () => {
  const now = new Date();
  const days = (n: number) => new Date(now.getTime() + n * DAY);

  const bondSec = (over: Partial<SecurityData> = {}): SecurityData => ({
    isin: 'RU000A0INT01',
    secid: 'INT1',
    name: 'Бонд Тест',
    securityType: 'bond',
    currency: 'RUB',
    faceValue: 1000,
    maturityDate: days(730),
    board: 'TQCB',
    lastPrice: 100,
    accruedInt: 0,
    tradingStatus: 'N',
    coupons: [
      { date: days(365), value: 100, type: 'fixed', faceAfter: 1000, isKnown: true, periodStart: null },
      { date: days(730), value: 100, type: 'fixed', faceAfter: 1000, isKnown: true, periodStart: null },
    ],
    offers: [],
    dividends: [],
    amortizations: [],
    ...over,
  });

  const bondRow = (over: Partial<PositionRow> = {}): PositionRow => ({
    isin: 'RU000A0INT01',
    name: 'Бонд Тест',
    category: 'Облигации',
    quantityEnd: 10,
    valueEnd: 10000,
    ...over,
  });

  const ofz: OfzPoint[] = [
    { secid: 'OFZ1', shortname: '', durationYears: 1, ytm: 5 },
    { secid: 'OFZ2', shortname: '', durationYears: 3, ytm: 7 },
  ];

  const bondInput = (over: Partial<PositionInput> = {}): PositionInput => ({
    row: bondRow(),
    cost: { isin: 'RU000A0INT01', name: 'Бонд Тест', buyQty: 10, buyCost: 1000, buyNkd: 0, buyFee: 0, netQty: 10 },
    security: bondSec(),
    ofzCurve: ofz,
    ...over,
  });

  it('бонд: costBasis из %-квоты через faceMult, marketValue = qty×(face×p/100 + НКД)', () => {
    const pm = calculatePortfolio([bondInput()]);
    const p = pm.positions[0];
    assert.equal(p.securityType, 'bond');
    // buyCost = 1000 (%×шт), faceMult = 1000/100 = 10 → 10000 ₽ на 10 шт
    assert.ok(Math.abs(p.costBasis - 10000) < 1e-6);
    assert.ok(Math.abs(p.marketValueFull - 10000) < 1e-6);
    assert.ok(Math.abs(p.pnl) < 1e-6);
    assert.equal(p.status, 'ok');
  });

  it('бонд: ytm ≈ 10% (пар), дюрация ≈ 1.909, dv01 ≈ 1.735 ₽', () => {
    const pm = calculatePortfolio([bondInput()]);
    const p = pm.positions[0];
    assert.ok(Math.abs(p.ytmMarket - 10) < 1e-6);
    assert.ok(Math.abs(p.durationMacaulay - 1.90909) < 1e-3);
    const modDur = p.durationMacaulay / (1 + p.ytmMarket / 100);
    assert.ok(Math.abs(p.durationModified - modDur) < 1e-9);
    assert.ok(Math.abs(p.dv01 - 0.0001 * modDur * p.marketValueFull) < 1e-6);
  });

  it('бонд: gSpread от интерполяции кривой (dur≈1.91 → bench≈5.91 → spread≈4.09)', () => {
    const pm = calculatePortfolio([bondInput()]);
    const p = pm.positions[0];
    assert.ok(p.gSpread !== null);
    assert.ok(Math.abs(p.gSpread - (10 - 5.90909)) < 1e-3);
  });

  it('бонд: couponYieldCurrent=10%, cashFlowToMaturity суммарно 12000 ₽ на 10 шт, incomeNext12m=1000 ₽', () => {
    const pm = calculatePortfolio([bondInput()]);
    const p = pm.positions[0];
    assert.ok(Math.abs(p.couponYieldCurrent - 10) < 1e-6);
    assert.equal(p.cashFlowToMaturity.coupons, 2000);
    assert.equal(p.cashFlowToMaturity.amortization, 0);
    assert.equal(p.cashFlowToMaturity.face, 10000);
    assert.equal(p.cashFlowToMaturity.total, 12000);
    assert.ok(Math.abs(p.incomeNext12m - 1000) < 1e-6);
  });

  it('акция: marketValue = qty×price, dividendYieldTtm по TTM-дивидендам', () => {
    const shareSec: SecurityData = {
      isin: 'RU000A0SHR01',
      secid: 'SHR1',
      name: 'Акция Тест',
      securityType: 'share',
      currency: 'RUB',
      faceValue: 0,
      maturityDate: null,
      board: 'TQBR',
      lastPrice: 100,
      accruedInt: 0,
      tradingStatus: 'N',
      coupons: [],
      offers: [],
      dividends: [
        { exDate: days(-30), valuePerShare: 10 },
        { exDate: days(-400), valuePerShare: 5 },
      ],
      amortizations: [],
    };
    const pm = calculatePortfolio([
      {
        row: { isin: 'RU000A0SHR01', name: 'Акция Тест', category: 'Акции', quantityEnd: 5, valueEnd: 500 },
        cost: { isin: 'RU000A0SHR01', name: 'Акция Тест', buyQty: 5, buyCost: 400, buyNkd: 0, buyFee: 0, netQty: 5 },
        security: shareSec,
        ofzCurve: ofz,
      },
    ]);
    const p = pm.positions[0];
    assert.equal(p.securityType, 'share');
    assert.ok(Math.abs(p.marketValueFull - 500) < 1e-6);
    assert.ok(Math.abs(p.costBasis - 400) < 1e-6);
    assert.ok(Math.abs(p.pnl - 100) < 1e-6);
    assert.ok(Math.abs(p.dividendYieldTtm - 10) < 1e-6);
    assert.ok(Math.abs(p.dividendIncomeYear - 50) < 1e-6);
    assert.ok(Math.abs(p.incomeNext12m - 50) < 1e-6);
    assert.equal(p.status, 'ok');
  });

  it('бумага не найдена → not_found, fallback на оценку брокера', () => {
    const pm = calculatePortfolio([
      {
        row: bondRow(),
        security: null,
        ofzCurve: ofz,
      },
    ]);
    const p = pm.positions[0];
    assert.equal(p.status, 'not_found');
    assert.equal(p.marketValueFull, 10000);
    assert.equal(p.costBasis, 10000);
    assert.equal(p.ytmMarket, 0);
  });

  it('tradingStatus отличен от N → delisted', () => {
    const pm = calculatePortfolio([bondInput({ security: bondSec({ tradingStatus: 'D' }) })]);
    assert.equal(pm.positions[0].status, 'delisted');
  });

  it('tradingStatus пустой → no_data', () => {
    const pm = calculatePortfolio([bondInput({ security: bondSec({ tradingStatus: '' }) })]);
    assert.equal(pm.positions[0].status, 'no_data');
  });

  it('неизвестный будущий купон → float_assumption', () => {
    const sec = bondSec({
      coupons: [
        { date: days(365), value: 100, type: 'fixed', faceAfter: 1000, isKnown: true, periodStart: null },
        { date: days(730), value: 0, type: 'float', faceAfter: 1000, isKnown: false, periodStart: null },
      ],
    });
    const pm = calculatePortfolio([bondInput({ security: sec })]);
    assert.equal(pm.positions[0].status, 'float_assumption');
  });

  it('портфельные агрегаты: вес, weightedDuration, dv01, avgYtm', () => {
    const pm = calculatePortfolio([bondInput()]);
    assert.ok(Math.abs(pm.weightsByType.bonds - 100) < 1e-9);
    assert.equal(pm.weightsByType.shares, 0);
    assert.equal(pm.weightsByType.etf, 0);
    assert.equal(pm.positions[0].weight, 100);
    assert.ok(Math.abs(pm.weightedDuration - pm.positions[0].durationMacaulay) < 1e-9);
    assert.ok(Math.abs(pm.portfolioDv01 - pm.positions[0].dv01) < 1e-9);
    assert.ok(Math.abs(pm.avgYtmBonds - 10) < 1e-6);
    assert.ok(Math.abs(pm.totalValue - 10000) < 1e-6);
    assert.ok(Math.abs(pm.totalCost - 10000) < 1e-6);
  });
});

// ── Синтез купонов флоатера (core/moex.ts) ────────────────

describe('synthesizeFloatCoupons', () => {
  const mk = (over: Partial<CouponEvent>): CouponEvent => ({
    date: dt(REF, 30),
    value: 0,
    type: 'float',
    faceAfter: 1000,
    isKnown: false,
    periodStart: dt(REF, 0),
    ...over,
  });

  it('КС 14% + спред 3.5% на номинал 1000 за 30 дней → 14.38 ₽', () => {
    const out = synthesizeFloatCoupons([mk({})], 1000, 14, 3.5, 12);
    assert.equal(out.length, 1);
    assert.ok(Math.abs(out[0].value - 14.38) < 0.01);
    assert.equal(out[0].isKnown, false);
    assert.equal(out[0].type, 'float');
  });

  it('известные купоны (value > 0) не перезаписываются', () => {
    const known = mk({ value: 50, isKnown: true });
    const out = synthesizeFloatCoupons([known, mk({})], 1000, 14, 3.5, 12);
    assert.equal(out[0].value, 50);
    assert.equal(out[0].isKnown, true);
  });

  it('без periodStart берётся период из частоты (365/12)', () => {
    const out = synthesizeFloatCoupons([mk({ periodStart: null })], 1000, 14, 3.5, 12);
    assert.ok(out[0].value > 0);
  });
});

describe('parseKeyRateHtml', () => {
  it('первая строка таблицы — последнее решение (14,00 %)', () => {
    const html = '<table><tr><td>11.09.2026</td><td>14,00</td></tr><tr><td>10.09.2026</td><td>14,00</td></tr></table>';
    assert.equal(parseKeyRateHtml(html), 14);
  });

  it('нет таблицы → null', () => {
    assert.equal(parseKeyRateHtml('<html>empty</html>'), null);
  });

  it('пустая строка → null', () => {
    assert.equal(parseKeyRateHtml(''), null);
  });
});