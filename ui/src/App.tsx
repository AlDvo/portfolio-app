import { useEffect, useMemo, useRef, useState } from 'react';
import type { Report } from './types';
import { PositionsTable } from './PositionsTable';
import { CashFlowChart } from './CashFlowChart';
import { PayoutsList } from './PayoutsList';
import { WarningsList } from './WarningsList';
import { UploadPanel } from './UploadPanel';
import { Sidebar } from './Sidebar';
import { BondRatingPage } from './BondRatingPage';
import { loadPortfolioFromFile } from './loadPortfolio';
import type { LoadProgress } from './loadPortfolio';
import './App.css';

const rub = (n: number, digits = 0): string =>
  n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const tabId = (): string => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function SummaryCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' | 'muted' }) {
  const cls = ['summary-card', tone ? `tone-${tone}` : ''].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <div className="summary-label">{label}</div>
      <div className="summary-value">{value}</div>
      {sub && <div className="summary-sub">{sub}</div>}
    </div>
  );
}

interface DateBounds {
  start: string;
  end: string;
}

function LoadingProgress({ progress, failedName }: { progress: LoadProgress; failedName: string | null }) {
  const pct = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
  return (
    <div className="app">
      <div className="loading-progress">
        <h1>{failedName ? `Не удалось загрузить «${failedName}»` : 'Считаем портфель…'}</h1>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="progress-note">
          Загрузка данных MOEX: {progress.loaded}/{progress.total} · {progress.name}
        </div>
      </div>
    </div>
  );
}

function App() {
  const [tabs, setTabs] = useState<{ id: string; name: string; report: Report; inputs?: any[]; ofzCurve?: any[]; meta?: any }[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<LoadProgress | null>(null);
  const [failedName, setFailedName] = useState<string | null>(null);
  /** null = диапазон по умолчанию (весь период событий) */
  const [range, setRange] = useState<DateBounds | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [includeAmort, setIncludeAmort] = useState(true);
  const [view, setView] = useState<'portfolio' | 'bond-rating'>('portfolio');
  const addInputRef = useRef<HTMLInputElement>(null);
  const addToCurrentRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: any) => {
      if (e.detail?.id === 'bond-rating') setView('bond-rating');
      if (e.detail?.id === 'valuation') setView('portfolio');
    };
    window.addEventListener('nav-change', handler);
    return () => window.removeEventListener('nav-change', handler);
  }, []);

  const report = tabs.find((t) => t.id === activeTabId)?.report ?? null;

  const mergeCurrentReport = async (file: File) => {
    const current = tabs.find((t) => t.id === activeTabId);
    if (!current || !current.inputs) {
      await handlePickFile(file);
      return;
    }
    setFailedName(file.name);
    setLoading({ loaded: 0, total: 1, name: file.name });
    try {
      const { inputs: inputs2, ofzCurve: ofz2 } = await loadPortfolioFromFile(file, (p) => setLoading(p));
      const mergedInputs = (await import('../../core/merge.js')).mergePositionInputs(current.inputs, inputs2);
      const ofzCurve = current.ofzCurve && current.ofzCurve.length > 0 ? current.ofzCurve : ofz2;
      for (const inp of mergedInputs) inp.ofzCurve = ofzCurve;
      const portfolio = (await import('../../core/calculator.js')).calculatePortfolio(mergedInputs);
      const newReport = { ...current.report, portfolio, generatedAt: new Date().toISOString() };
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? { ...t, name: t.name + ' + ' + file.name.replace(/\.xlsx?$/i, ''), report: newReport, inputs: mergedInputs, ofzCurve }
            : t,
        ),
      );
      setFailedName(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  };

  const clearAll = () => {
    setTabs([]);
    setActiveTabId(null);
    setError(null);
    setRange(null);
    setSelectedMonth(null);
  };

  const switchTab = (id: string) => {
    setActiveTabId(id);
    setRange(null);
    setSelectedMonth(null);
  };

  const closeTab = (id: string) => {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (next.length === 0) {
      setActiveTabId(null);
    } else if (activeTabId === id) {
      setActiveTabId(next[Math.min(idx, next.length - 1)].id);
    }
    setRange(null);
    setSelectedMonth(null);
  };

  const addReport = (name: string, r: Report, inputs?: any[], ofzCurve?: any[], meta?: any) => {
    const id = tabId();
    setTabs((prev) => [...prev, { id, name, report: r, inputs, ofzCurve, meta }]);
    setActiveTabId(id);
    setError(null);
    setRange(null);
    setSelectedMonth(null);
  };

  const handlePickFile = async (file: File) => {
    if (!/\.xlsx?$/i.test(file.name)) {
      setError(`Формат «${file.name}» не поддерживается — нужен файл .xlsx`);
      return;
    }
    setFailedName(file.name);
    setLoading({ loaded: 0, total: 1, name: file.name });
    try {
      const { meta, portfolio, inputs, ofzCurve } = await loadPortfolioFromFile(file, (p) => setLoading(p));
      addReport(file.name.replace(/\.xlsx?$/i, ''), { generatedAt: new Date().toISOString(), meta, portfolio }, inputs, ofzCurve, meta);
      setFailedName(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  };

  const handleLoadDemo = async () => {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}portfolio.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: Report = await r.json();
      addReport('Демо-данные', d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const bounds = useMemo<DateBounds>(() => {
    if (!report) return { start: '', end: '' };
    const dates = report.portfolio.cashFlowCalendar.map((e) => e.date);
    if (dates.length === 0) return { start: '', end: '' };
    return {
      start: dates.reduce((a, b) => (a < b ? a : b)),
      end: dates.reduce((a, b) => (a > b ? a : b)),
    };
  }, [report]);

  const activeRange: DateBounds = range ?? (() => {
    if (!report) return bounds;
    if (bounds.start && bounds.end) {
      const d = new Date();
      d.setFullYear(d.getFullYear() + 1);
      const iso = d.toISOString().slice(0, 10);
      return { start: bounds.start, end: iso };
    }
    return bounds;
  })();

  const visibleMonths = useMemo(() => {
    if (!report) return [];
    const start = activeRange.start.slice(0, 7);
    const end = activeRange.end.slice(0, 7);
    if (includeAmort) {
      return report.portfolio.cashFlowByMonth.filter((m) => m.month >= start && m.month <= end);
    }
    const eventsInRange = report.portfolio.cashFlowCalendar.filter(
      (e) => e.date >= activeRange.start && e.date <= activeRange.end && e.type !== 'amortization',
    );
    const byMonth = new Map<string, number>();
    for (const ev of eventsInRange) {
      const m = ev.date.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) || 0) + ev.amount);
    }
    return Array.from(byMonth.entries())
      .map(([month, amount]) => ({ month, amount }))
      .filter((m) => m.month >= start && m.month <= end)
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [report, activeRange, includeAmort]);

  const visibleEvents = useMemo(() => {
    if (!report) return [];
    let ev = report.portfolio.cashFlowCalendar
      .filter((e) => e.date >= activeRange.start && e.date <= activeRange.end);
    if (!includeAmort) {
      ev = ev.filter((e) => e.type !== 'amortization');
    }
    return ev.sort((a, b) => a.date.localeCompare(b.date));
  }, [report, activeRange, includeAmort]);

  useEffect(() => {
    if (selectedMonth) {
      const start = activeRange.start.slice(0, 7);
      const end = activeRange.end.slice(0, 7);
      if (selectedMonth < start || selectedMonth > end) setSelectedMonth(null);
    }
  }, [selectedMonth, activeRange]);

  const setBound = (key: 'start' | 'end', value: string) => {
    setRange((prev) => ({ ...(prev ?? bounds), [key]: value }));
  };

  if (view === 'bond-rating') {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <BondRatingPage />
        </main>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <LoadingProgress progress={loading} failedName={failedName} />
        </main>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <UploadPanel busy={loading} error={error} onPick={handlePickFile} onLoadDemo={handleLoadDemo} onRetry={clearAll} />
        </main>
      </div>
    );
  }

  const { meta, portfolio: pf } = report;
  const accountLabel = meta.accountType === 'iis' ? 'ИИС' : meta.accountType === 'regular' ? 'обычный' : 'не определён';
  const pnlTone = pf.pnlPercentTotal >= 0 ? 'up' : 'down';
  const pnlSign = pf.pnlTotal >= 0 ? '+' : '';

  const monthCount = visibleMonths.length;
  const monthWord = monthCount === 1 ? 'месяц' : monthCount < 5 ? 'месяца' : 'месяцев';

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <nav className="tabs-bar" aria-label="Портфели">
          {tabs.map((t) => (
            <div key={t.id} className={`report-tab${t.id === activeTabId ? ' active' : ''}`}>
              <button type="button" className="report-tab-main" onClick={() => switchTab(t.id)} title={`${t.report.meta.client} · ${t.report.meta.agreement}`}>
                {t.name}
              </button>
              <button type="button" className="report-tab-close" onClick={() => closeTab(t.id)} aria-label={`Закрыть ${t.name}`}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="report-tab-add" onClick={() => addInputRef.current?.click()}>
            + Загрузить отчёт
          </button>
          {tabs.length > 0 && activeTabId && (
            <button type="button" className="report-tab-add" onClick={() => addToCurrentRef.current?.click()}>
              + Добавить к текущему
            </button>
          )}
          <input
            ref={addInputRef}
            type="file"
            accept=".xlsx,.xls"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handlePickFile(f);
              e.target.value = '';
            }}
          />
          <input
            ref={addToCurrentRef}
            type="file"
            accept=".xlsx,.xls"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) mergeCurrentReport(f);
              e.target.value = '';
            }}
          />
        </nav>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button type="button" className="error-banner-close" onClick={() => setError(null)} aria-label="Закрыть">
              ×
            </button>
          </div>
        )}

        <div className="app">
          <header className="topbar">
            <div className="topbar-title">Оценка портфеля</div>
            <div className="topbar-meta">
              {meta.client} · {meta.agreement} · счёт: {accountLabel}
            </div>
            <div className="topbar-period">
              {meta.reportPeriodStart} — {meta.reportPeriodEnd}
            </div>
          </header>

          <section className="summary-grid">
            <SummaryCard label="Всего" value={`${rub(pf.totalValue)} ₽`} sub={`база ${rub(pf.totalCost)} ₽`} />
            <SummaryCard
              label="P/L"
              value={`${pnlSign}${rub(pf.pnlTotal)} ₽`}
              sub={`${pnlSign}${rub(pf.pnlPercentTotal, 2)}%`}
              tone={pnlTone}
            />
            <SummaryCard label="Дюрация" value={`${rub(pf.weightedDuration, 2)} г`} sub={`DV01 ${rub(pf.portfolioDv01)} ₽`} />
            <SummaryCard label="YTM облигаций" value={`${rub(pf.avgYtmBonds, 2)}%`} />
            <SummaryCard
              label="Доход за 12 мес"
              value={`${rub(pf.totalIncome12m)} ₽`}
              sub={`${rub(pf.totalIncome12mPercent, 2)}% · купоны ${rub(pf.couponIncome12m)} ₽`}
            />
            <SummaryCard
              label="Структура"
              value={`обл ${rub(pf.weightsByType.bonds, 1)}%`}
              sub={`акц ${rub(pf.weightsByType.shares, 1)}% · фонды ${rub(pf.weightsByType.etf, 1)}%`}
            />
          </section>

          <PositionsTable positions={pf.positions} />

          <section className="card range-card">
            <div className="range-controls">
              <span className="range-label">Период потоков</span>
              <label className="range-field">
                от
                <input
                  type="date"
                  value={activeRange.start}
                  min={bounds.start}
                  max={activeRange.end}
                  onChange={(e) => setBound('start', e.target.value)}
                />
              </label>
              <label className="range-field">
                до
                <input
                  type="date"
                  value={activeRange.end}
                  min={activeRange.start}
                  max={bounds.end}
                  onChange={(e) => setBound('end', e.target.value)}
                />
              </label>
              <label className="range-field" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={includeAmort} onChange={(e) => setIncludeAmort(e.target.checked)} />
                Амортизация
              </label>
              {range && (
                <button type="button" className="range-reset" onClick={() => setRange(null)}>
                  Сбросить
                </button>
              )}
              <span className="range-note">
                показано {monthCount} {monthWord} · {rub(visibleEvents.reduce((s, e) => s + e.amount, 0))} ₽
              </span>
            </div>
          </section>

          <section className="panels">
            <CashFlowChart
              byMonth={visibleMonths}
              events={visibleEvents}
              selectedMonth={selectedMonth}
              onSelectMonth={setSelectedMonth}
            />
            <PayoutsList events={visibleEvents} />
          </section>

          <WarningsList positions={pf.positions} />
        </div>
      </main>
    </div>
  );
}

export default App;