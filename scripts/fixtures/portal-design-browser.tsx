import React, { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { portalDesignStore } from "./portal-design-browser-mocks";
import { portalDesignHref, portalDesignLocation, portalDesignStates, type PortalDesignState, type PortalDesignView } from "./portal-design-store";
import ContributorPortal from "../../artifacts/negis/src/pages/ContributorPortal";
import OperatorPortal from "../../artifacts/negis/src/pages/OperatorPortal";
import "../../artifacts/negis/src/index.css";

const viewLabels = { partner: "Партнёр", creator: "Автор контента", operator: "Оператор" };
const stateLabels = { ready: "Готово", empty: "Пусто", error: "Ошибка", denied: "Нет доступа", "signed-out": "Без входа", pending: "На рассмотрении", suspended: "Приостановлено" };

function Harness() {
  const [location, setLocation] = useState(() => portalDesignLocation(window.location.href));
  const [revision, setRevision] = useState(0);
  const navigate = (view: PortalDesignView, state: PortalDesignState = portalDesignStore.snapshot().state) => {
    history.pushState(null, "", portalDesignHref(view, state));
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  useEffect(() => {
    const update = () => {
      const next = portalDesignLocation(window.location.href);
      if (next.state !== portalDesignStore.snapshot().state) portalDesignStore.setState(next.state);
      portalDesignStore.navigate(next.view); setLocation(next); setRevision(value => value + 1);
    };
    window.addEventListener("popstate", update);
    Object.assign((window as any).__portalDesignQA, { navigateView: navigate, remount: () => setRevision(value => value + 1) });
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    if (location.view !== "creator") return;
    // Exercise the real production mode button, not a second portal renderer.
    const chooseCreator = () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".portal-workspace button")]
        .find(element => element.textContent?.trim() === "Автор контента");
      if (!button) return;
      observer.disconnect(); button.click();
    };
    const observer = new MutationObserver(chooseCreator);
    observer.observe(document.getElementById("portal-design-production")!, { childList: true, subtree: true });
    chooseCreator(); return () => observer.disconnect();
  }, [location.view, revision]);
  return <>
    <aside aria-label="Локальный тестовый стенд" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "8px 16px", background: "#fff", color: "#26382e", borderBottom: "1px solid #d6ded9", fontSize: 12 }}>
      <strong>Тестовый стенд · синтетические данные, не реальные средства · без внешних запросов</strong>
      <label>Вид <select aria-label="Тестовый вид" value={location.view} onChange={event => navigate(event.target.value as PortalDesignView)}>{Object.entries(viewLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Состояние <select aria-label="Тестовое состояние" value={location.state} onChange={event => navigate(location.view, event.target.value as PortalDesignState)}>{portalDesignStates.map(value => <option key={value} value={value}>{stateLabels[value]}</option>)}</select></label>
      <button className="neu-btn" type="button" onClick={() => setRevision(value => value + 1)}>Перезапустить вид</button>
    </aside>
    <div id="portal-design-production" key={`${location.view}:${revision}`}>
      {location.view === "operator" ? <OperatorPortal /> : <ContributorPortal />}
    </div>
  </>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
