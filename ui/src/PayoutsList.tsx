import type { CashFlowEvent } from './types';
import { FLOW_LABEL } from './types';

const money = (n: number): string => n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });

const dateLabel = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

export function PayoutsList({ events }: { events: CashFlowEvent[] }) {
  const next = events.slice(0, 15);
  return (
    <section className="card">
      <h2 className="card-title">Ближайшие выплаты</h2>
      <p className="muted card-sub">в выбранном периоде</p>
      {next.length === 0 ? (
        <p className="muted">Нет событий в выбранном периоде</p>
      ) : (
        <ul className="payouts">
          {next.map((e, i) => (
            <li key={i} className="payout">
              <span className={`payout-type type-${e.type}`}>{FLOW_LABEL[e.type]}</span>
              <span className="payout-date">{dateLabel(e.date)}</span>
              <span className="payout-name" title={e.name}>
                {e.name}
              </span>
              <span className="payout-amount">{money(e.amount)} ₽</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}