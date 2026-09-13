// ============================================================
// Типы прототипа расчётного ядра
// Источник: docs/data-model-and-metrics.md
// ============================================================

// ── Парсинг Excel ──────────────────────────────────────────

export interface PortfolioMeta {
  reportPeriodStart: string;
  reportPeriodEnd: string;
  client: string;
  agreement: string;
  accountType: 'iis' | 'regular' | 'unknown';
}

export interface PositionRow {
  isin: string;
  name: string;
  category: 'Акции' | 'Облигации' | 'Прочее' | 'Валюта';
  quantityEnd: number;
  valueEnd: number;
}

export interface PositionCost {
  isin: string;
  name: string;
  buyQty: number;
  buyCost: number;
  buyNkd: number;
  buyFee: number;
  netQty: number;
}

// ── MOEX ───────────────────────────────────────────────────

export interface CouponEvent {
  date: Date;
  value: number;           // ₽ на бумагу
  type: 'fixed' | 'float';
  faceAfter: number;       // остаток номинала после выплаты
  isKnown: boolean;
  periodStart: Date | null; // начало купонного периода (startdate в MOEX); null если неизвестно
}

// Точка кривой ОФЗ (для G-spread): дюрация → доходность
export interface OfzPoint {
  secid: string;
  shortname: string;
  durationYears: number;   // модифицированная дюрация в годах (DURATION с MOEX)
  ytm: number;             // эффективная доходность к погашению, % годовых
}

export interface SecurityData {
  isin: string;
  secid: string;
  name: string;
  securityType: 'bond' | 'share' | 'etf';
  currency: string;
  faceValue: number;
  maturityDate: Date | null;
  board: string;

  lastPrice: number;
  accruedInt: number;
  tradingStatus: string;

  coupons: CouponEvent[];
  offers: { date: Date; price: number }[];
  dividends: { exDate: Date; valuePerShare: number }[];
  amortizations: { date: Date; value: number; faceAfter: number }[];
}

// ── Расчёт — позиция ──────────────────────────────────────

export interface PositionMetrics {
  // исходные
  isin: string;
  name: string;
  securityType: 'bond' | 'share' | 'etf';
  quantity: number;
  avgPriceNet: number;
  currency: string;

  // оценка
  lastPrice: number;
  accruedInt: number;
  marketValueFull: number;
  costBasis: number;
  pnl: number;
  pnlPercent: number;
  weight: number;

  // доходность (облигации)
  couponYieldCurrent: number;
  couponYieldSimpleToMaturity: number;
  ytmMarket: number;
  ytmFromPurchase: number;
  ytpFromPurchase: number | null;

  // риск (облигации)
  durationMacaulay: number;
  durationModified: number;
  dv01: number;
  gSpread: number | null;

  // дивиденды (акции/фонды)
  dividendYieldTtm: number;
  dividendIncomeYear: number;

  // денежные потоки (облигации)
  cashFlowToMaturity: {
    coupons: number;
    amortization: number;
    face: number;
    total: number;
  };
  incomeNext12m: number;

  // статус
  status: 'ok' | 'not_found' | 'delisted' | 'no_data' | 'float_assumption';
}

// ── Расчёт — портфель ─────────────────────────────────────

export interface CashFlowEvent {
  date: string;
  isin: string;
  name: string;
  type: 'coupon' | 'amortization' | 'maturity' | 'dividend';
  amount: number;
}

export interface PortfolioMetrics {
  totalValue: number;
  totalCost: number;
  pnlTotal: number;
  pnlPercentTotal: number;

  positions: PositionMetrics[];
  weightsByType: { bonds: number; shares: number; etf: number };

  weightedDuration: number;
  portfolioDv01: number;
  avgYtmBonds: number;

  couponIncome12m: number;
  dividendIncome12m: number;
  totalIncome12m: number;
  totalIncome12mPercent: number;

  cashFlowCalendar: CashFlowEvent[];
  cashFlowByMonth: { month: string; amount: number }[];
}
