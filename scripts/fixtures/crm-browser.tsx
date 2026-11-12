import React from "react";
import { createRoot } from "react-dom/client";
import { Link, Route, Router, Switch, useLocation } from "wouter";
import { Toaster } from "sonner";
import { ArrowLeftRight, Repeat2, RotateCw, Play, Pause, Copy, CircleX } from "../../artifacts/negis/node_modules/lucide-react";
import "./crm-browser-mocks";
import "../../artifacts/negis/src/index.css";
import { AppointmentsPage } from "../../artifacts/negis/src/pages/AppointmentsPage";
import ClientsPage from "../../artifacts/negis/src/pages/ClientsPage";
import SalesPage from "../../artifacts/negis/src/pages/SalesPage";
import LeadsPage from "../../artifacts/negis/src/pages/LeadsPage";
import Login from "../../artifacts/negis/src/pages/Login";
import Privacy from "../../artifacts/negis/src/pages/Privacy";
import Terms from "../../artifacts/negis/src/pages/Terms";
import DataDeletion from "../../artifacts/negis/src/pages/DataDeletion";
import AdminCenter from "../../artifacts/negis/src/pages/AdminCenter";
import MortgageOverview from '../../artifacts/negis/src/pages/MortgageOverview';
import MortgageClients from '../../artifacts/negis/src/pages/MortgageClients';
import MortgageCalendar from '../../artifacts/negis/src/pages/MortgageCalendar';
import MortgageTasks from '../../artifacts/negis/src/pages/MortgageTasks';
import MortgageAnalytics from '../../artifacts/negis/src/pages/MortgageAnalytics';
import {useAuth, suspendOperatorFixture, endOperatorCooperationFixture, operatorDispatchFixture, clinicArrivalFixture, appointmentCreateFixture, contentStudioFixture, advertisingDemoFixture} from './crm-browser-mocks';
import OperatorPortal from '../../artifacts/negis/src/pages/OperatorPortal';
import { OperatorArrivals } from '../../artifacts/negis/src/components/operators/OperatorArrivals';
import { clinicArrivalFixtureIds } from './clinic-arrival-browser-store';
import ContentStudio from '../../artifacts/negis/src/pages/ContentStudio';
import { contentStudioFixtureIds } from './content-studio-browser-store';
import { ADVERTISING_CAMPAIGN_PREFILL_KEY, parseAdvertisingCampaignPrefillForPlatform } from '../../lib/advertising/campaignBrief';
import AdvertisingHub from '../../artifacts/negis/src/pages/AdvertisingHub';
import { isAdvertisingDemoFixtureLocation, readAdvertisingDemoGoalPrefill } from './advertising-demo-browser-store';

const mortgage=useAuth().workspacePurpose==='mortgage_leads';
const contentClipboard = contentStudioFixture
  ? Object.freeze({ writeText: contentStudioFixture.writeClipboard }) : null;

function AdvertisingDemoFixtureView() {
  const fixture = advertisingDemoFixture!;
  const snapshot = React.useSyncExternalStore(fixture.subscribe, fixture.snapshot);
  const [location] = useLocation();
  const hub = location === "/ads" && isAdvertisingDemoFixtureLocation(window.location);
  const destination = ["/content-studio", "/ads-automation"].includes(location) && !window.location.search && !window.location.hash;
  const received = destination ? readAdvertisingDemoGoalPrefill(localStorage, location) : null;
  return <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }} data-testid="advertising-demo-fixture">
    <section aria-label="ТЕСТ: реклама и сессия" className="shrink-0 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-slate-900">
      <strong>ТЕСТ G5-C21: локальная реклама, без сети и расходов</strong>
      <div role="group" aria-label="ТЕСТ: SDK рекламы" className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="neu-btn" onClick={fixture.switchActor}><ArrowLeftRight size={14} />ТЕСТ: SDK A/B</button>
        <button type="button" className="neu-btn" disabled={snapshot.sdkActor !== "A"} onClick={fixture.switchABA}><Repeat2 size={14} />ТЕСТ: SDK A-B-A</button>
        <button type="button" className="neu-btn" onClick={fixture.refreshSameActor}><RotateCw size={14} />ТЕСТ: TOKEN_REFRESHED</button>
      </div>
      <pre aria-label="ТЕСТ: состояние рекламы" data-testid="advertising-demo-state"
        className="mt-2 whitespace-pre-wrap break-words" style={{ maxHeight: 120, overflow: "auto" }}>{JSON.stringify(snapshot)}</pre>
    </section>
    <div style={{ minHeight: 0, flex: 1, overflow: "auto", transform: "translateZ(0)" }} data-testid="advertising-demo-scene">
      {hub ? <AdvertisingHub /> : <main className="space-y-3 p-4" data-testid="advertising-demo-destination">
        <h1 className="text-lg font-semibold">ТЕСТ: локальная цель рекламы</h1>
        {received ? <pre aria-label="ТЕСТ: принятая цель" className="whitespace-pre-wrap break-words">{JSON.stringify(received, null, 2)}</pre>
          : <p role="alert">ТЕСТ: текущая передача не подтверждена.</p>}
        <Link href="/ads?advertising=demo" className="neu-btn">Вернуться к локальной рекламе</Link>
      </main>}
    </div>
  </div>;
}

function AdvertisingDemoFixture() {
  return advertisingDemoFixture ? <React.StrictMode><AdvertisingDemoFixtureView /></React.StrictMode>
    : <p role="alert">ТЕСТ: реклама доступна только с явным локальным режимом.</p>;
}

function ContentStudioFixtureView() {
  const fixture = contentStudioFixture!;
  const snapshot = React.useSyncExternalStore(fixture.subscribe, fixture.snapshot);
  const [location] = useLocation();
  const [clipboardReady, setClipboardReady] = React.useState(false);
  React.useEffect(() => {
    setClipboardReady(false);
    try {
      const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      if (previous?.value !== contentClipboard) {
        if (previous && !previous.configurable) return;
        Object.defineProperty(navigator, "clipboard", { configurable: false, writable: false, value: contentClipboard });
      }
      setClipboardReady(true);
    } catch { return; }
    // This fixture document never falls back to the native clipboard. Closing
    // or reloading the document removes the replacement without reading it.
  }, [fixture]);

  let received = null;
  if (location === "/ads-automation") {
    try {
      const value = JSON.parse(localStorage.getItem(`${ADVERTISING_CAMPAIGN_PREFILL_KEY}::${contentStudioFixtureIds.workspace}`) || "null");
      const parsed = parseAdvertisingCampaignPrefillForPlatform(value, "meta");
      const sourceId = snapshot.actor === "A" ? contentStudioFixtureIds.ideaA : contentStudioFixtureIds.ideaB;
      if (parsed?.sourceKind === "library" && parsed.sourceId === sourceId) received = parsed;
    } catch { /* Only a valid, current synthetic library handoff is displayed. */ }
  }
  return <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }} data-testid="content-studio-fixture">
    <section aria-label="ТЕСТ: контент и сессия" className="shrink-0 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-slate-900">
      <strong>ТЕСТ C15: только вымышленные данные и имитация буфера обмена</strong>
      <div role="group" aria-label="ТЕСТ: управление контентом" className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="neu-btn" onClick={fixture.switchActor}><ArrowLeftRight size={14} />ТЕСТ: сменить аккаунт</button>
        <button type="button" className="neu-btn" disabled={snapshot.actor !== "A"} onClick={fixture.switchABA}><Repeat2 size={14} />ТЕСТ: A-B-A</button>
        <button type="button" className="neu-btn" onClick={fixture.refreshSameActor}><RotateCw size={14} />ТЕСТ: обновить сессию</button>
        <button type="button" className="neu-btn" onClick={fixture.armNextSdk}><Pause size={14} />ТЕСТ: удержать SDK</button>
        <button type="button" className="neu-btn" onClick={fixture.release}><Play size={14} />ТЕСТ: отпустить SDK</button>
        <button type="button" className="neu-btn" onClick={fixture.armNextClipboard}><Pause size={14} />ТЕСТ: задержать копирование</button>
        <button type="button" className="neu-btn" onClick={fixture.failNextClipboard}><CircleX size={14} />ТЕСТ: отказ копирования</button>
        <button type="button" className="neu-btn" onClick={fixture.releaseClipboard}><Copy size={14} />ТЕСТ: завершить копирование</button>
      </div>
      <pre aria-label="ТЕСТ: состояние контента" data-testid="content-fixture-state"
        className="mt-2 whitespace-pre-wrap break-words" style={{ maxHeight: 120, overflow: "auto" }}>{JSON.stringify(snapshot)}</pre>
    </section>
    <div style={{ minHeight: 0, flex: 1, overflow: "auto", transform: "translateZ(0)" }} data-testid="content-fixture-scene">
      {!clipboardReady || Object.getOwnPropertyDescriptor(navigator, "clipboard")?.value !== contentClipboard
        ? <p role="alert">ТЕСТ: изолированный буфер ещё не готов; действия недоступны.</p>
        : location === "/ads-automation" ? <main className="space-y-3 p-4">
          <h1 className="text-lg font-semibold">ТЕСТ: локальная передача контента</h1>
          <p>Рекламный раздел не запускается; показывается только проверочный черновик этого стенда.</p>
          {received ? <pre aria-label="ТЕСТ: принятый черновик" className="whitespace-pre-wrap break-words">{JSON.stringify(received, null, 2)}</pre>
            : <p role="alert">ТЕСТ: текущая передача не подтверждена.</p>}
          <a href="/content-studio?contentStudio=handoff" className="neu-btn">Новая локальная проверка</a>
        </main> : <ContentStudio />}
    </div>
  </div>;
}

function ContentStudioFixture() {
  return contentStudioFixture ? <React.StrictMode><ContentStudioFixtureView /></React.StrictMode>
    : <p role="alert">ТЕСТ: контент доступен только с явным локальным режимом.</p>;
}

function AppointmentCreateFixture() {
  const fixture = appointmentCreateFixture!;
  const snapshot = React.useSyncExternalStore(fixture.subscribe, fixture.snapshot);
  return <div className="flex min-w-0 flex-col overflow-hidden" style={{ height: "100dvh" }} data-testid="appointment-create-fixture">
    <section aria-label="ТЕСТ: создание записи G2-C12" className="shrink-0 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-slate-900">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <strong>ТЕСТ G2-C12: только локальная симуляция</strong>
        <div role="group" aria-label="ТЕСТ: аккаунт" className="flex flex-wrap items-center gap-2">
          <button type="button" className="neu-btn inline-flex items-center gap-2 text-xs" onClick={fixture.switchActor}>
            <ArrowLeftRight size={14} aria-hidden="true" />ТЕСТ: актор {snapshot.actor === "A" ? "B" : "A"}
          </button>
          <button type="button" className="neu-icon-btn" title="ТЕСТ: сырые события A-B-A синхронно"
            aria-label="ТЕСТ: сырые события A-B-A" disabled={snapshot.actor !== "A"} onClick={fixture.switchABA}>
            <Repeat2 size={16} aria-hidden="true" />
          </button>
          <button type="button" className="neu-icon-btn" title="ТЕСТ: TOKEN_REFRESHED того же актора"
            aria-label="ТЕСТ: обновить сессию того же актора" onClick={fixture.refreshSameActor}>
            <RotateCw size={16} aria-hidden="true" />
          </button>
        </div>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={snapshot.role === "doctor"} onChange={fixture.toggleRole} />
          ТЕСТ: роль doctor (иначе owner)
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2">ТЕСТ: удержание
            <select className="max-w-full rounded border border-amber-300 bg-white p-1" value={snapshot.phase}
              disabled={snapshot.held > 0} onChange={(event) => fixture.setPhase(event.target.value === "response" ? "response" : "lookup")}>
              <option value="lookup">До отправки</option><option value="response">После отправки</option>
            </select>
          </label>
          <button type="button" className="neu-btn inline-flex items-center gap-2 text-xs" disabled={!snapshot.held} onClick={fixture.release}>
            <Play size={14} aria-hidden="true" />ТЕСТ: отпустить запрос
          </button>
        </div>
      </div>
      <p role="status" className="mt-2 break-words" data-testid="appointment-create-actor">
        ТЕСТ: {snapshot.actor} / {snapshot.actorId} / {snapshot.role}; поколение {snapshot.revision}; SDK-событий {snapshot.authEvents}; обновлений {snapshot.refreshes}
      </p>
      <p role="status" className="mt-1 break-words" data-testid="appointment-create-counts">
        ТЕСТ: POST-вызовов {snapshot.calls}; в очереди всего {snapshot.queued}; удержано до/после {snapshot.heldQueued}/{snapshot.heldResponse}; отправлено {snapshot.dispatched}; заблокировано {snapshot.blocked}; ответов {snapshot.replies}; поздних {snapshot.lateReplies}; ключей {snapshot.keys}
      </p>
      <p className="mt-1">ТЕСТ: A/B в одной вымышленной клинике; без сети. Это не проверка транспорта или сохранения на сервере.</p>
      {snapshot.lastReply && <p role="status" className="mt-1">ТЕСТ: последний ответ {snapshot.lastReply.actor}/{snapshot.lastReply.role}; {snapshot.lastReply.replayed ? "повтор ключа" : "новый ключ"}; {snapshot.lastReply.stale ? "устаревший" : "текущий"}</p>}
    </section>
    {/* A containing block reserves the controls' space even for the page's fixed modal/navigation. */}
    <div className="min-h-0 flex-1 overflow-hidden" style={{ transform: "translateZ(0)" }} data-appointment-create-scene="true">
      <style>{`[data-appointment-create-scene] .fixed.inset-0 > form { max-height: 100%; }`}</style>
      <div className="h-full overflow-y-auto"><AppointmentsPage /></div>
    </div>
  </div>;
}

function ClinicArrivalFixtureView() {
  const fixture = clinicArrivalFixture!;
  const snapshot = React.useSyncExternalStore(fixture.subscribe, fixture.snapshot);
  const lifetime = snapshot.lifetime;
  return <main className="mx-auto w-full max-w-4xl space-y-4 p-4">
    <h1 className="text-xl font-semibold">ТЕСТ: приходы клиники</h1>
    <p>ТЕСТ: локальная композиция, не проверка входа или базы данных</p>
    <div role="group" aria-label="ТЕСТ: управление акторами" className="flex flex-wrap items-center gap-3">
      <button type="button" className="neu-btn" onClick={fixture.switchActor}>ТЕСТ: сменить актор A/B</button>
      <button type="button" className="neu-btn" disabled={lifetime.actor !== "A"}
        onClick={fixture.switchABA}>ТЕСТ: A-B-A одним нажатием</button>
      <button type="button" className="neu-btn" disabled={!snapshot.held}
        onClick={fixture.release}>ТЕСТ: отпустить ожидающий запрос</button>
    </div>
    <p role="status">ТЕСТ: актор {lifetime.actor}; поколение {lifetime.revision}; фаза {snapshot.phase}; ответ {snapshot.reply}</p>
    <p role="status">ТЕСТ: в очереди {snapshot.queued}; отправок {snapshot.dispatched}; отменено {snapshot.canceled}</p>
    {snapshot.lastOutcome && <p role="status">ТЕСТ: {snapshot.lastOutcome.reply === "success" ? "локальное подтверждение" : "локальный сбой"}; актор {snapshot.lastOutcome.actor}; поколение {snapshot.lastOutcome.revision}</p>}
    <OperatorArrivals key={lifetime.revision} actorId={lifetime.actorId}
      isSessionCurrent={lifetime.isSessionCurrent} workspaceId={clinicArrivalFixtureIds.workspace}
      requestId={clinicArrivalFixtureIds.request} />
  </main>;
}

function ClinicArrivalFixture() {
  return clinicArrivalFixture
    ? <React.StrictMode><ClinicArrivalFixtureView /></React.StrictMode>
    : <p role="alert">ТЕСТ: доступ только на локальном стенде</p>;
}

function DispatchFixtureControls() {
  const [snapshot, setSnapshot] = React.useState(() => operatorDispatchFixture!.snapshot());
  React.useEffect(() => operatorDispatchFixture!.subscribe(() => setSnapshot(operatorDispatchFixture!.snapshot())), []);
  return <div className="flex flex-wrap items-center gap-3 border-b p-3">
    <button type="button" className="neu-btn" disabled={!snapshot.held}
      onClick={() => operatorDispatchFixture!.release()}>ТЕСТ: отпустить ожидающий запрос</button>
    <p role="status">ТЕСТ: в очереди {snapshot.queued}; отправок {snapshot.dispatched}; отменено {snapshot.canceled}</p>
  </div>;
}

function OperatorFixture() {
  const [revoked, setRevoked] = React.useState(false);
  const [ended, setEnded] = React.useState(false);
  return <React.StrictMode>
    {operatorDispatchFixture && <DispatchFixtureControls />}
    <div className="border-b p-3 flex flex-wrap gap-3"><button type="button" className="neu-btn" disabled={revoked}
      onClick={() => { suspendOperatorFixture(); setRevoked(true); }}>
      {revoked ? "ТЕСТ: одобрение отозвано" : "ТЕСТ: отозвать одобрение"}
    </button><button type="button" className="neu-btn" disabled={ended}
      onClick={() => { endOperatorCooperationFixture(); setEnded(true); }}>
      {ended ? "ТЕСТ: сотрудничество завершено" : "ТЕСТ: завершить сотрудничество"}
    </button></div>
    <OperatorPortal />
  </React.StrictMode>;
}

const fixtureRoot = createRoot(document.getElementById("root")!);
fixtureRoot.render(<Router>{advertisingDemoFixture ? <AdvertisingDemoFixture /> : <Switch>
  <Route path="/ads" component={AdvertisingDemoFixture} />
  <Route path="/content-studio" component={ContentStudioFixture} />
  <Route path="/ads-automation" component={ContentStudioFixture} />
  <Route path="/clinic-arrival" component={ClinicArrivalFixture} />
  <Route path="/operator" component={OperatorFixture} />
  <Route path="/appointments" component={appointmentCreateFixture?AppointmentCreateFixture:mortgage?MortgageCalendar:AppointmentsPage} />
  <Route path="/clients" component={mortgage?MortgageClients:ClientsPage} />
  <Route path="/dashboard" component={MortgageOverview} />
  <Route path="/tasks" component={MortgageTasks} />
  <Route path="/analytics" component={MortgageAnalytics} />
  <Route path="/admin" component={AdminCenter} />
  <Route path="/sales" component={SalesPage} />
  <Route path="/leads" component={LeadsPage} />
  <Route path="/login" component={Login} />
  <Route path="/privacy" component={Privacy} />
  <Route path="/terms" component={Terms} />
  <Route path="/data-deletion" component={DataDeletion} />
  <Route component={AppointmentsPage} />
</Switch>}<Toaster /></Router>);
if (import.meta.hot) import.meta.hot.dispose(() => fixtureRoot.unmount());
