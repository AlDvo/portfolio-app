export const DAY_MS = 86400000;
export const ROUND2 = 100;
export const ROUND4 = 10000;

export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * ROUND2) / ROUND2;
}

export function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * ROUND4) / ROUND4;
}

export function safeNum(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export function toDateISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / DAY_MS;
}

export function yearsBetween(a: Date, b: Date): number {
  return daysBetween(a, b) / 365;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isPast(d: Date, ref: Date): boolean {
  return d.getTime() < ref.getTime();
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
