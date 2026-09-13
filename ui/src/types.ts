import type {
  CashFlowEvent as CoreCashFlowEvent,
  PositionMetrics as CorePosition,
  PortfolioMeta as CoreMeta,
  PortfolioMetrics as CorePortfolio,
} from '../../core/types.js';

export type AccountType = CoreMeta['accountType'];
export type SecurityType = CorePosition['securityType'];
export type Status = CorePosition['status'];
export type FlowType = CoreCashFlowEvent['type'];

export type Meta = CoreMeta;
export type Position = CorePosition;
export type Portfolio = CorePortfolio;
export type CashFlowEvent = CoreCashFlowEvent;

export interface WeightsByType {
  bonds: number;
  shares: number;
  etf: number;
}

export interface CashFlowByMonth {
  month: string;
  amount: number;
}

export interface Report {
  generatedAt: string;
  meta: Meta;
  portfolio: Portfolio;
}

export const STATUS_LABEL: Record<Status, string> = {
  ok: 'ok',
  float_assumption: 'допущение',
  no_data: 'нет данных',
  delisted: 'не торгуется',
  not_found: 'не найдена',
};

export const FLOW_LABEL: Record<FlowType, string> = {
  coupon: 'купон',
  amortization: 'амортизация',
  maturity: 'погашение',
  dividend: 'дивиденды',
};