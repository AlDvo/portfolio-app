import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import XLSX from 'xlsx';
import { calculatePortfolio, PositionInput } from '../core/calculator.js';
import { CBR_KEY_RATE_URL, FALLBACK_KEY_RATE_PCT, fetchKeyRatePct, loadOfzCurve, loadSecurity } from '../core/moex.js';
import { parseBrokerReport } from '../core/parser.js';
import { writeJsonReport } from './export.js';

const xlsx = () => readdirSync(process.cwd()).filter((f) => f.endsWith('.xlsx'));

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function jsonOutArg(args: string[]): string | null {
  const i = args.indexOf('--json');
  if (i < 0) return null;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : 'portfolio.json';
}

async function main(): Promise<void> {
  const files = xlsx();
  if (!files.length) {
    console.error('Не найден ни один файл *.xlsx в текущей директории.');
    process.exit(1);
  }
  if (files.length > 1) {
    console.error('Найдено несколько *.xlsx — укажите файл аргументом: npx tsx src/index.ts <file>');
    process.exit(1);
  }
  const file = join(process.cwd(), files[0]);

  const { meta, positions, costs } = parseBrokerReport(XLSX.readFile(file));
  console.log(`Файл:       ${files[0]}`);
  console.log(`Клиент:     ${meta.client}`);
  console.log(`Договор:    ${meta.agreement}`);
  console.log(`Период:     ${meta.reportPeriodStart} — ${meta.reportPeriodEnd}`);
  console.log(`Счет:       ${meta.accountType === 'iis' ? 'ИИС' : meta.accountType === 'regular' ? 'обычный' : 'не определён'}`);
  console.log(`Позиций:    ${positions.length}`);
  console.log('');

  console.log('Загрузка данных MOEX…');
  const keyRatePct = (await fetchKeyRatePct(CBR_KEY_RATE_URL)) ?? FALLBACK_KEY_RATE_PCT;
  console.log(`Ключевая ставка ЦБ: ${keyRatePct}%`);
  const costByIsin = new Map(costs.map((c) => [c.isin, c]));
  const inputs: PositionInput[] = [];
  for (const [i, p] of positions.entries()) {
    const security = await loadSecurity(p.isin, { keyRatePct });
    console.log(`  [${i + 1}/${positions.length}] ${p.name.slice(0, 40).padEnd(40)} → ${security ? `${security.secid} (${security.securityType})` : 'НЕ НАЙДЕНО'}`);
    inputs.push({ row: p, cost: costByIsin.get(p.isin), security, ofzCurve: [] });
    await new Promise((r) => setTimeout(r, 120)); // пауза между запросами к ISS
  }
  const ofzCurve = await loadOfzCurve();
  for (const i of inputs) i.ofzCurve = ofzCurve;
  console.log(`  ОФЗ-кривая: ${ofzCurve.length} точек`);
  console.log('');

  const pf = calculatePortfolio(inputs);
  const jsonFile = jsonOutArg(process.argv.slice(2));
  if (jsonFile) {
    writeJsonReport(join(process.cwd(), jsonFile), meta, pf);
    console.log(`JSON:       ${jsonFile}`);
  }

  // ── Таблица позиций ──
  console.log('ПОЗИЦИИ');
  console.log('─'.repeat(132));
  console.log(
    'NAМИРОВАНИЕ                                  Тип   Кол-во   Цена     Стоимость   База      P/L %    Куп.Y   YTM %   Дюр,г   DV01    G-spr   Статус'
  );
  for (const p of pf.positions) {
    const name = p.name.slice(0, 42).padEnd(42);
    const type = (p.securityType === 'bond' ? 'обл' : p.securityType === 'share' ? 'акц' : 'етф').padEnd(6);
    const dur = p.securityType === 'bond' ? fmt(p.durationMacaulay) : '—';
    const ytm = p.securityType === 'bond' ? (p.ytmMarket > 0 ? fmt(p.ytmMarket) : '—') : '—';
    const dv01 = p.securityType === 'bond' ? fmt(p.dv01) : '—';
    const gs = p.securityType === 'bond' && p.gSpread != null ? fmt(p.gSpread) : '—';
    console.log(
      `${name}${type}${fmt(p.quantity, 0).padStart(6)}${fmt(p.lastPrice).padStart(9)}` +
        `${fmt(p.marketValueFull).padStart(11)}${fmt(p.costBasis).padStart(10)}${fmt(p.pnlPercent).padStart(8)}` +
        `${fmt(p.couponYieldCurrent).padStart(7)}${ytm.padStart(7)}${dur.padStart(6)}${dv01.padStart(8)}${gs.padStart(7)}  ${p.status}`
    );
  }
  console.log('─'.repeat(132));
  console.log(
    `${'ИТОГО'.padEnd(48)}${fmt(pf.totalValue).padStart(17)}${fmt(pf.totalCost).padStart(10)}${fmt(pf.pnlPercentTotal).padStart(8)}` +
      `${' '.repeat(62)}`
  );
  console.log('');

  // ── Сводка портфеля ──
  console.log('ПОРТФЕЛЬ');
  console.log(`  Всего:               ${fmt(pf.totalValue)} ₽  (база ${fmt(pf.totalCost)} ₽, P/L ${fmt(pf.pnlTotal)} ₽ = ${fmt(pf.pnlPercentTotal)}%)`);
  console.log(`  Структура:           облигации ${fmt(pf.weightsByType.bonds)}% · акции ${fmt(pf.weightsByType.shares)}% · фонды ${fmt(pf.weightsByType.etf)}%`);
  console.log(`  Дюрация (средняя):   ${fmt(pf.weightedDuration)} г · DV01 портфеля ${fmt(pf.portfolioDv01)} ₽`);
  console.log(`  YTM облигаций:       ${fmt(pf.avgYtmBonds)}%`);
  console.log(`  Доход за 12 мес:     купоны ${fmt(pf.couponIncome12m)} ₽ + дивиденды ${fmt(pf.dividendIncome12m)} ₽ = ${fmt(pf.totalIncome12m)} ₽ (${fmt(pf.totalIncome12mPercent)}%)`);
  console.log('');

  // ── Календарь денежных потоков ──
  console.log('КАЛЕНДАРЬ ДЕНЕЖНЫХ ПОТОКОВ');
  console.log('─'.repeat(70));
  for (const m of pf.cashFlowByMonth) {
    console.log(`  ${m.month}  ${fmt(m.amount, 0).padStart(10)} ₽`);
  }
  if (pf.cashFlowByMonth.length) {
    const totalNextYear = pf.cashFlowByMonth.filter((m) => m.month <= new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 7))
      .reduce((s, m) => s + m.amount, 0);
    console.log('─'.repeat(70));
    console.log(`  за 12 мес: ${fmt(totalNextYear, 0)} ₽`);
  }
  console.log('');
  console.log('БЛИЖАЙШИЕ ВЫПЛАТЫ');
  for (const cf of pf.cashFlowCalendar.slice(0, 15)) {
    console.log(`  ${cf.date}  ${(cf.type === 'coupon' ? 'купон     ' : cf.type === 'amortization' ? 'амортизация' : cf.type === 'maturity' ? 'погашение  ' : 'дивиденды  ')} ${cf.name.slice(0, 32).padEnd(32)} ${fmt(cf.amount).padStart(10)} ₽`);
  }

  // ── Статусы ──
  const warn = pf.positions.filter((p) => p.status !== 'ok');
  if (warn.length) {
    console.log('');
    console.log('ПРЕДУПРЕЖДЕНИЯ');
    for (const p of warn) {
      const msg = p.status === 'not_found' ? 'не найдена на MOEX' : p.status === 'delisted' ? 'не торгуется' : p.status === 'no_data' ? 'нет рыночных данных' : 'купонная доходность по допущению (последний известный купон/ставка по бенчмарку)';
      console.log(`  [${p.status}] ${p.name.slice(0, 40)} — ${msg}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});