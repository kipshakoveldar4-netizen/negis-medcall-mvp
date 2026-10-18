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
import {useAuth, suspendOperatorFixture, endOperatorCooperationFixture} from './crm-browser-mocks';
import OperatorPortal from '../../artifacts/negis/src/pages/OperatorPortal';

const mortgage=useAuth().workspacePurpose==='mortgage_leads';

function OperatorFixture() {
  const [revoked, setRevoked] = React.useState(false);
  const [ended, setEnded] = React.useState(false);
  return <React.StrictMode>
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
