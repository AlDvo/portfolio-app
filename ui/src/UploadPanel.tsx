import { useRef, useState } from 'react';
import type { LoadProgress } from './loadPortfolio';

interface UploadPanelProps {
  busy: LoadProgress | null;
  error: string | null;
  onPick: (file: File) => void;
  onLoadDemo: () => void;
  onRetry: () => void;
}

export function UploadPanel({ busy, error, onPick, onLoadDemo, onRetry }: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [badFile, setBadFile] = useState<string | null>(null);

  const handleFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    if (!/\.xlsx?$/i.test(f.name)) {
      setBadFile(`Формат «${f.name}» не поддерживается — нужен файл .xlsx`);
      return;
    }
    setBadFile(null);
    onPick(f);
  };

  return (
    <div className="app upload-screen">
      <header className="topbar">
        <div className="topbar-title">Оценка портфеля</div>
        <div className="topbar-meta">Анализ брокерского отчёта Альфа-Банка</div>
      </header>

      <div className="upload-body">
        <h1 className="upload-heading">Загрузите отчёт</h1>
        <p className="upload-sub">Файл читается локально в браузере, затем позиции обогащаются данными MOEX.</p>

        <div
          className={`upload-zone${drag ? ' drag' : ''}${busy ? ' busy' : ''}`}
          onClick={() => !busy && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            handleFiles(e.dataTransfer.files);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) inputRef.current?.click();
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls"
            hidden
            disabled={!!busy}
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="upload-icon">XLSX</div>
          <div className="upload-title">{busy ? 'Обработка…' : 'Выберите файл или перетащите его сюда'}</div>
          <div className="upload-hint">Отчёт «Брокерский … (период).xlsx» из Альфа-Инвестиций</div>
        </div>

        {badFile && <div className="error-box upload-error">{badFile}</div>}
        {error && (
          <div className="error-box upload-error">
            <h1>Не удалось рассчитать портфель</h1>
            <p>{error}</p>
            <button type="button" className="range-reset" onClick={onRetry}>
              Попробовать снова
            </button>
          </div>
        )}

        <button type="button" className="demo-button" onClick={onLoadDemo} disabled={!!busy}>
          Или загрузить демо-данные (portfolio.json)
        </button>
      </div>
    </div>
  );
}