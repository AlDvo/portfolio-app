import type { Position } from './types';
import { STATUS_LABEL } from './types';

const MESSAGE: Record<Position['status'], string> = {
  ok: '',
  float_assumption: 'купонная доходность по допущению (последний известный купон/ставка по бенчмарку)',
  no_data: 'нет рыночных данных',
  delisted: 'не торгуется',
  not_found: 'не найдена на MOEX',
};

export function WarningsList({ positions }: { positions: Position[] }) {
  const warn = positions.filter((p) => p.status !== 'ok');
  if (warn.length === 0) return null;
  return (
    <section className="card">
      <h2 className="card-title">Предупреждения</h2>
      <ul className="warnings">
        {warn.map((p) => (
          <li key={p.isin} className="warning">
            <span className={`badge badge-${p.status === 'not_found' ? 'notfound' : p.status === 'delisted' ? 'delisted' : p.status === 'no_data' ? 'nodata' : 'assumption'}`}>
              {STATUS_LABEL[p.status]}
            </span>
            <span className="warning-name">{p.name}</span>
            <span className="warning-msg">— {MESSAGE[p.status]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}