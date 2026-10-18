import React from "react";
import { createRoot } from "react-dom/client";
import { Route, Router, Switch } from "wouter";
import { Toaster } from "sonner";
import "./crm-browser-mocks";
import "../../artifacts/negis/src/index.css";
import { AppointmentsPage } from "../../artifacts/negis/src/pages/AppointmentsPage";
import ClientsPage from "../../artifacts/negis/src/pages/ClientsPage";
import SalesPage from "../../artifacts/negis/src/pages/SalesPage";
import LeadsPage from "../../artifacts/negis/src/pages/LeadsPage";
import Login from "../../artifacts/negis/src/pages/Login";
import AdminCenter from "../../artifacts/negis/src/pages/AdminCenter";
import MortgageOverview from '../../artifacts/negis/src/pages/MortgageOverview';
import MortgageClients from '../../artifacts/negis/src/pages/MortgageClients';
import MortgageCalendar from '../../artifacts/negis/src/pages/MortgageCalendar';
import MortgageTasks from '../../artifacts/negis/src/pages/MortgageTasks';
import MortgageAnalytics from '../../artifacts/negis/src/pages/MortgageAnalytics';
import {useAuth, suspendOperatorFixture, endOperatorCooperationFixture, operatorDispatchFixture, clinicArrivalFixture} from './crm-browser-mocks';
import OperatorPortal from '../../artifacts/negis/src/pages/OperatorPortal';
import { OperatorArrivals } from '../../artifacts/negis/src/components/operators/OperatorArrivals';
import { clinicArrivalFixtureIds } from './clinic-arrival-browser-store';

const mortgage=useAuth().workspacePurpose==='mortgage_leads';

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

createRoot(document.getElementById("root")!).render(<Router><Switch>
  <Route path="/clinic-arrival" component={ClinicArrivalFixture} />
  <Route path="/operator" component={OperatorFixture} />
  <Route path="/appointments" component={mortgage?MortgageCalendar:AppointmentsPage} />
  <Route path="/clients" component={mortgage?MortgageClients:ClientsPage} />
  <Route path="/dashboard" component={MortgageOverview} />
  <Route path="/tasks" component={MortgageTasks} />
  <Route path="/analytics" component={MortgageAnalytics} />
  <Route path="/admin" component={AdminCenter} />
  <Route path="/sales" component={SalesPage} />
  <Route path="/leads" component={LeadsPage} />
  <Route path="/login" component={Login} />
  <Route component={AppointmentsPage} />
</Switch><Toaster /></Router>);
