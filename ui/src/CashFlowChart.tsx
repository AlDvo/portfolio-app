import { useEffect, useMemo } from 'react';
import type { CashFlowByMonth, CashFlowEvent } from './types';
import { FLOW_LABEL } from './types';

const RUB = (n: number): string => n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });

const dateLabel = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

const monthLabel = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
};

interface Props {
  byMonth: CashFlowByMonth[];
  events: CashFlowEvent[];
  selectedMonth: string | null;
  onSelectMonth: (month: string | null) => void;
}

/** Бар-чарт денежных потоков по месяцам. Клик по столбцу открывает попап со списком событий месяца. */
export function CashFlowChart({ byMonth, events, selectedMonth, onSelectMonth }: Props) {
  const max = useMemo(() => Math.max(...byMonth.map((m) => m.amount), 1), [byMonth]);

  const selectedEvents = useMemo(() => {
    if (!selectedMonth) return [];
    return events
      .filter((e) => e.date.startsWith(selectedMonth))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [events, selectedMonth]);

  const selectedTotal = useMemo(() => selectedEvents.reduce((s, e) => s + e.amount, 0), [selectedEvents]);

  useEffect(() => {
    if (!selectedMonth) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSelectMonth(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedMonth, onSelectMonth]);

  const toggle = (month: string) => onSelectMonth(month === selectedMonth ? null : month);

  return (
    <section className="card">
      <h2 className="card-title">Денежные потоки по месяцам</h2>
      {byMonth.length === 0 ? (
        <p className="muted">Нет данных в выбранном периоде</p>
      ) : (
        <div className="chart">
          {byMonth.map((m) => (
            <div
              key={m.month}
              className={`chart-col${m.month === selectedMonth ? ' selected' : ''}`}
              title={`${m.month}: ${RUB(m.amount)} ₽ — клик для деталей`}
              onClick={() => toggle(m.month)}
            >
              <div className="chart-bar-wrap">
                <div className="chart-bar" style={{ height: `${Math.max(2, (m.amount / max) * 100)}%` }} />
              </div>
              <div className="chart-label">{m.month.slice(2)}</div>
            </div>
          ))}
        </div>
      )}

      {selectedMonth && (
        <div className="modal-overlay" onClick={() => onSelectMonth(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-title">
                Выплаты · {monthLabel(selectedMonth)}
                <span className="modal-count">
                  {selectedEvents.length} {selectedEvents.length === 1 ? 'событие' : 'событий'}
                </span>
              </div>
              <button type="button" className="modal-close" onClick={() => onSelectMonth(null)} aria-label="Закрыть">
                ×
              </button>
            </div>

            {selectedEvents.length === 0 ? (
              <p className="muted">В этот месяц событий нет</p>
            ) : (
              <>
                <ul className="modal-list">
                  {selectedEvents.map((e, i) => (
                    <li key={i} className="modal-row">
                      <span className={`payout-type type-${e.type}`}>{FLOW_LABEL[e.type]}</span>
                      <span className="payout-date">{dateLabel(e.date)}</span>
                      <span className="payout-name" title={e.name}>
                        {e.name}
                      </span>
                      <span className="payout-amount">{RUB(e.amount)} ₽</span>
                    </li>
                  ))}
                </ul>
                <div className="modal-total">
                  Итого за месяц: <strong>{RUB(selectedTotal)} ₽</strong>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}