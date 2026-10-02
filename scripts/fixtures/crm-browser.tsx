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

createRoot(document.getElementById("root")!).render(<Router><Switch>
  <Route path="/appointments" component={AppointmentsPage} />
  <Route path="/clients" component={ClientsPage} />
  <Route path="/sales" component={SalesPage} />
  <Route path="/leads" component={LeadsPage} />
  <Route path="/login" component={Login} />
  <Route component={AppointmentsPage} />
</Switch><Toaster /></Router>);
