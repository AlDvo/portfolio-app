import { useMemo, useState } from 'react';
import type { Position, Status } from './types';
import { STATUS_LABEL } from './types';

type SortKey =
  | 'name'
  | 'securityType'
  | 'quantity'
  | 'lastPrice'
  | 'marketValueFull'
  | 'costBasis'
  | 'pnlPercent'
  | 'couponYieldCurrent'
  | 'ytmMarket'
  | 'durationMacaulay'
  | 'dv01'
  | 'gSpread'
  | 'status';

interface Column {
  key: SortKey;
  label: string;
  numeric: boolean;
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Наименование', numeric: false },
  { key: 'securityType', label: 'Тип', numeric: false },
  { key: 'quantity', label: 'Кол-во', numeric: true },
  { key: 'lastPrice', label: 'Цена', numeric: true },
  { key: 'marketValueFull', label: 'Стоимость', numeric: true },
  { key: 'costBasis', label: 'База', numeric: true },
  { key: 'pnlPercent', label: 'P/L %', numeric: true },
  { key: 'couponYieldCurrent', label: 'Куп. Y', numeric: true },
  { key: 'ytmMarket', label: 'YTM %', numeric: true },
  { key: 'durationMacaulay', label: 'Дюр, г', numeric: true },
  { key: 'dv01', label: 'DV01', numeric: true },
  { key: 'gSpread', label: 'G-spr', numeric: true },
  { key: 'status', label: 'Статус', numeric: false },
];

const COLUMN_HINT: Record<SortKey, string> = {
  name: 'Название эмитента и выпуска',
  securityType: 'Класс актива: облигация, акция или ETF',
  quantity: 'Количество бумаг в позиции',
  lastPrice: 'Последняя рыночная цена бумаги',
  marketValueFull: 'Рыночная стоимость позиции с учётом НКД',
  costBasis: 'Стоимость покупки позиции (база для P/L)',
  pnlPercent: 'Относительный результат: (стоимость − база) / база × 100%',
  couponYieldCurrent: 'Текущая купонная доходность = купоны за 12 мес × 100% / стоимость',
  ytmMarket: 'Доходность к погашению по рыночной цене (YTM)',
  durationMacaulay: 'Дюрация Маколея в годах — средневзвешенный срок до выплат',
  dv01: 'DV01 — изменение стоимости позиции при сдвиге доходности на 0,01 п.п.',
  gSpread: 'G-spread — спред доходности бумаги к кривой ОФЗ',
  status: 'Состояние бумаги: допущение / нет данных / не торгуется и др.',
};

interface Tooltip {
  key: SortKey;
  x: number;
  y: number;
}

const TYPE_LABEL: Record<Position['securityType'], string> = {
  bond: 'обл',
  share: 'акц',
  etf: 'етф',
};

const STATUS_CLASS: Record<Status, string> = {
  ok: 'badge-ok',
  float_assumption: 'badge-assumption',
  no_data: 'badge-nodata',
  delisted: 'badge-delisted',
  not_found: 'badge-notfound',
};

const num = (n: number, digits = 2): string =>
  n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const blank = (p: Position, key: SortKey): boolean => {
  switch (key) {
    case 'gSpread':
      return p.gSpread == null;
    case 'ytmMarket':
    case 'durationMacaulay':
    case 'dv01':
    case 'couponYieldCurrent':
      return p.securityType !== 'bond' || p[key] === 0;
    default:
      return false;
  }
};

function valueOf(p: Position, key: SortKey): string | number {
  switch (key) {
    case 'name':
      return p.name.toLowerCase();
    case 'securityType':
      return TYPE_LABEL[p.securityType];
    case 'status':
      return STATUS_LABEL[p.status];
    case 'gSpread':
      return p.gSpread ?? -Infinity;
    default:
      return p[key] as number;
  }
}

export function PositionsTable({ positions }: { positions: Position[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('marketValueFull');
  const [asc, setAsc] = useState(false);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const sorted = useMemo(() => {
    const list = [...positions];
    list.sort((a, b) => {
      const va = valueOf(a, sortKey);
      const vb = valueOf(b, sortKey);
      const cmp = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb, 'ru') : (va as number) - (vb as number);
      return asc ? cmp : -cmp;
    });
    return list;
  }, [positions, sortKey, asc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setAsc((v) => !v);
    } else {
      setSortKey(key);
      setAsc(false);
    }
  };

  const showHint = (key: SortKey, e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ key, x: rect.left + rect.width / 2, y: rect.bottom + 8 });
  };

  return (
    <section className="card">
      <h2 className="card-title">Позиции</h2>
      <div className="table-wrap">
        <table className="positions-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={c.numeric ? 'num' : ''}
                  onClick={() => toggleSort(c.key)}
                  onMouseEnter={(e) => showHint(c.key, e)}
                  onMouseLeave={() => setTooltip(null)}
                >
                  {c.label}
                  {sortKey === c.key && <span className="sort-mark">{asc ? ' ▲' : ' ▼'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.isin}>
                <td className="name-cell" title={p.name}>
                  {p.name}
                </td>
                <td className="num">{TYPE_LABEL[p.securityType]}</td>
                <td className="num">{num(p.quantity, 0)}</td>
                <td className="num">{num(p.lastPrice)}</td>
                <td className="num">{num(p.marketValueFull)}</td>
                <td className="num">{num(p.costBasis)}</td>
                <td className={`num ${p.pnlPercent >= 0 ? 'pos' : 'neg'}`}>{num(p.pnlPercent)}</td>
                <td className="num">{blank(p, 'couponYieldCurrent') ? '—' : num(p.couponYieldCurrent)}</td>
                <td className="num">{blank(p, 'ytmMarket') ? '—' : num(p.ytmMarket)}</td>
                <td className="num">{blank(p, 'durationMacaulay') ? '—' : num(p.durationMacaulay)}</td>
                <td className="num">{blank(p, 'dv01') ? '—' : num(p.dv01)}</td>
                <td className="num">{blank(p, 'gSpread') ? '—' : num(p.gSpread ?? 0)}</td>
                <td>
                  <span className={`badge ${STATUS_CLASS[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {tooltip && (
        <div className="col-hint" style={{ left: tooltip.x, top: tooltip.y }}>
          <span className="col-hint-title">{COLUMNS.find((c) => c.key === tooltip.key)?.label}</span>
          {COLUMN_HINT[tooltip.key]}
        </div>
      )}
    </section>
  );
}