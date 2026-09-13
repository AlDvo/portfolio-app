import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PortfolioMeta, PortfolioMetrics } from '../core/types.js';

export interface JsonReport {
  generatedAt: string;
  meta: PortfolioMeta;
  portfolio: PortfolioMetrics;
}

/** Полная сериализация результата расчёта для UI. */
export function writeJsonReport(file: string, meta: PortfolioMeta, portfolio: PortfolioMetrics): void {
  const report: JsonReport = {
    generatedAt: new Date().toISOString(),
    meta,
    portfolio,
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
}