import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from 'wouter';
import './crm-browser-mocks';
import '../../artifacts/negis/src/index.css';
import MortgageCalendar from '../../artifacts/negis/src/pages/MortgageCalendar';
import { UpdatePrompt } from '../../artifacts/negis/src/components/layout/UpdatePrompt';

function Fixture() {
  const [protectedDraft, setProtectedDraft] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!protectedDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [protectedDraft]);
  return <>
    <aside className="flex flex-wrap items-center gap-3 border-b bg-amber-50 p-3 text-xs" aria-label="ТЕСТ: управление PWA">
      <strong>ТЕСТ: отдельный локальный service worker, без рабочих данных</strong>
      {import.meta.env.VITE_PWA_FIXTURE_LABEL && <output data-testid="pwa-built-label">{import.meta.env.VITE_PWA_FIXTURE_LABEL}</output>}
      <button type="button" className="neu-btn" onClick={async () => {
        // crm-browser-mocks denies fetch; this sole fixture control uses a
        // same-origin XHR to the closed in-memory version endpoint instead.
        const version = await new Promise<number>((resolve) => {
          const request = new XMLHttpRequest();
          request.open('POST', '/__qa/version'); request.setRequestHeader('Content-Type', 'application/json');
          request.onload = () => resolve(request.status === 200 ? JSON.parse(request.responseText).version : 0);
          request.onerror = () => resolve(0); request.send('{}');
        });
        if (!version) { setMessage('ТЕСТ: отказ переключения'); return; }
        await (await navigator.serviceWorker.getRegistration())?.update();
        setMessage(`ТЕСТ: версия ${version} скачивается`);
      }}>ТЕСТ: новая версия</button>
      <label><input id="qa-protect-draft" type="checkbox" checked={protectedDraft} onChange={event => setProtectedDraft(event.target.checked)} /> ТЕСТ: предупреждать перед уходом</label>
      <input aria-label="ТЕСТ: несохранённый текст" className="neu-input" defaultValue="" />
      <span role="status" data-testid="pwa-fixture-state">{message}</span>
    </aside>
    <Router><MortgageCalendar /><UpdatePrompt /></Router>
  </>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
