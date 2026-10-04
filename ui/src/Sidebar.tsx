import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

interface NavItem {
  id: string;
  label: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'valuation',
    label: 'Оценка портфеля',
    icon: (
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <rect x="3" y="10" width="3" height="6" rx="1" fill="currentColor" />
        <rect x="8.5" y="5" width="3" height="11" rx="1" fill="currentColor" />
        <rect x="14" y="2.5" width="3" height="13.5" rx="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'bond-rating',
    label: 'Оценка облигации/эмитента',
    icon: (
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <circle cx="10" cy="7" r="3" fill="currentColor" />
        <path d="M3 17c0-3.866 3.134-7 7-7s7 3.134 7 7" stroke="currentColor" strokeWidth="2" fill="none" />
      </svg>
    ),
  },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1');
  const [active, setActive] = useState('valuation');

  useEffect(() => {
    const handler = (e: any) => {
      if (e.detail?.id) setActive(e.detail.id);
    };
    window.addEventListener('nav-change', handler);
    return () => window.removeEventListener('nav-change', handler);
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sidebar-collapsed', next ? '1' : '0');
  };

  return (
    <nav className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Основное меню">
      <div
        className="sidebar-toggle"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => e.key === 'Enter' && toggle()}
        aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
      >
        <span className="sidebar-toggle-icon">{collapsed ? '»' : '«'}</span>
        <span className="sidebar-toggle-label">{collapsed ? 'Меню' : 'Свернуть'}</span>
      </div>
      <ul className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`sidebar-item${item.id === active ? ' active' : ''}`}
              onClick={() => {
                setActive(item.id);
                window.dispatchEvent(new CustomEvent('nav-change', { detail: { id: item.id } }));
              }}
              title={item.label}
            >
              <span className="sidebar-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="sidebar-label">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}