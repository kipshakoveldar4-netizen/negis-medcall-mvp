import { createBookingRetryFixture } from "./booking-retry";
import { createOperatorBrowserFixture } from "./operator-browser-store";
import { createOperatorDispatchFixture } from "./operator-dispatch-fixture";
import { createClinicArrivalBrowserFixture, isClinicArrivalFixtureLocation, type ClinicArrivalGuardedInit } from "./clinic-arrival-browser-store";
import { mortgageBrowserRequest, mortgageLeadBrowserRequest, mortgageFixtureAdmin } from './mortgage-browser-store';
import { mortgageOutcomesBrowserRequest } from './mortgage-outcomes-browser-store';
import type { MortgageSnapshot } from '../../lib/crm/mortgage-contract';
import { appointmentCreateFixtureIds, createAppointmentCreateBrowserFixture, isAppointmentCreateFixtureLocation } from "./appointment-create-browser-store";
const retryFixture = new URLSearchParams(window.location?.search || "").get("bookingRetry") === "lost-response"
  ? createBookingRetryFixture() : null;
const fixtureParams = new URLSearchParams(window.location?.search || "");
export const appointmentCreateFixture = isAppointmentCreateFixtureLocation(window.location)
  ? createAppointmentCreateBrowserFixture(window.location.search) : null;
const saleRetryFixture = fixtureParams.get("salesRetry") === "lost-response" ? createBookingRetryFixture() : null;
const fixtureTimeZone = ["UTC", "Pacific/Chatham"].includes(fixtureParams.get("fixtureTimeZone") || "")
  ? fixtureParams.get("fixtureTimeZone")! : "Asia/Almaty";
const fixtureAppointmentTime = fixtureParams.get("fixtureAppointment") === "midnight" ? "00:10" : "10:00";
const fixturePriceMinor = fixtureParams.get("fixturePrice") === "fractional" ? 1250050 : 1250000;
export const clinicArrivalFixture = isClinicArrivalFixtureLocation(window.location)
  ? createClinicArrivalBrowserFixture(window.location.search) : null;
// Keep explicit visual-test settings across local page reloads, not CRM data.
for (const key of ["fixtureRole", "fixturePurpose"]) {
  const value = fixtureParams.get(key);
  if (value) sessionStorage.setItem(`medina-visual:${key}`, value);
  else if (sessionStorage.getItem(`medina-visual:${key}`)) fixtureParams.set(key, sessionStorage.getItem(`medina-visual:${key}`)!);
}
const fixtureRole = fixtureParams.get("fixtureRole");
const assignedLeadFixture = !appointmentCreateFixture && fixtureRole === "lead_manager";
const mortgageFixture = !appointmentCreateFixture && fixtureParams.get("fixturePurpose") === "mortgage_leads";
const operatorFixture = createOperatorBrowserFixture();
export const operatorDispatchFixture = fixtureParams.get("operatorDispatch") === "deferred"
  ? createOperatorDispatchFixture((url, init) => operatorFixture.request(url, init)) : null;
export const suspendOperatorFixture = () => operatorFixture.suspend();
export const endOperatorCooperationFixture = () => operatorFixture.endCooperation();
const workspaceId = appointmentCreateFixture ? appointmentCreateFixtureIds.workspace : "00000000-0000-4000-8000-000000000001";
const clientId = "00000000-0000-4000-8000-000000000002";
const doctorId = "00000000-0000-4000-8000-000000000003";
const serviceId = "00000000-0000-4000-8000-000000000004";
const appointmentId = "00000000-0000-4000-8000-000000000005";
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Almaty" });
const longName = "Тестовая Александра Константинопольская";
const teamMembers = Array.from({ length: 5 }, (_, index) => ({
  staffId: `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
  name: index === 0 ? longName : `Тестовый менеджер ${index + 1}`,
  role: "lead_manager", status: index === 4 ? "inactive" : "active",
  assigned: { total: 1, new: index === 0 ? 1 : 0, inProgress: index === 1 ? 1 : 0,
    booked: index === 2 ? 1 : 0, lost: index === 3 ? 1 : 0, other: index === 4 ? 1 : 0 },
  activity: { updatedEvents: index + 1, createdEvents: 1, touchedLeads: 1, lastRecordedAt: new Date().toISOString() },
}));
const service = "Тестовая комплексная услуга с очень длинным названием";
const client = { id: clientId, name: longName, fullName: longName, full_name: longName, phone: "+77000000001", whatsapp: "+77000000001", status: "active", source: "Тест", visits: 2, notes: "Только вымышленные данные" };
const appointment = { id: appointmentId, clientId, client: longName, client_name: longName, phone: client.phone, client_phone: client.phone, whatsapp: client.whatsapp, doctorId, doctor: "Тестовый специалист", doctor_name: "Тестовый специалист", service, service_name: service, serviceId, startsAt: `${today}T${fixtureAppointmentTime}:00+05:00`, starts_at: `${today}T${fixtureAppointmentTime}:00+05:00`, durationMinutes: 90, priceMinor: fixturePriceMinor, status: "confirmed", notes: "Вымышленная запись для проверки вёрстки" };
const historyStartsAt = new Date(Date.parse(appointment.startsAt) - 7 * 86_400_000).toISOString();
const lists: Record<string, unknown[]> = {
  appointments: [appointment, ...(fixtureParams.get("fixturePrice") === "fractional" ? [{
    ...appointment, id: "00000000-0000-4000-8000-000000000099", startsAt: historyStartsAt, starts_at: historyStartsAt, status: "arrived",
  }] : [])],
  clients: [client, { ...client, id: "00000000-0000-4000-8000-000000000006", name: "Тестовая Мария", full_name: "Тестовая Мария", fullName: "Тестовая Мария", phone: "+77000000002" }],
  deals: [{ id: "00000000-0000-4000-8000-000000000007", clientId, client: longName, client_name: longName, title: service, service, service_name: service, amountMinor: fixturePriceMinor, amount_minor: fixturePriceMinor, currency: "KZT", status: "paid", paidAt: `${today}T10:00:00+05:00`, createdAt: `${today}T10:00:00+05:00` }],
  leads: [{ id: "00000000-0000-4000-8000-000000000008", client: longName, client_name: longName, name: longName, phone: client.phone, service, source: "Тестовая реклама", status: "new", createdAt: new Date().toISOString() }],
  "clinic-doctors": [{ id: doctorId, fullName: "Тестовый специалист", specialty: "Тестовый прайс", isActive: true }],
  "clinic-services": [{ id: serviceId, name: service, doctorId, basePriceMinor: fixturePriceMinor, durationMinutes: 90, isActive: true }],
};
const keys: Record<string, string> = { "clinic-doctors": "doctors", "clinic-services": "services", "doctor-shifts": "shifts" };
export const hasSupabaseFrontendEnv = true;
export const arrivedByRecoveryLink = false;
export const supabase = { auth: {
  getSession: async () => ({ data: { session: appointmentCreateFixture ? appointmentCreateFixture.session() : ["/admin", "/operator"].includes(window.location.pathname)
    ? { user: { id: window.location.pathname === "/operator" ? "00000000-0000-4000-8000-000000000805" : "fixture-user" }, access_token: "visual-fixture-not-a-valid-token" } : null } }),
  signInWithPassword: async () => ({ data: null, error: { message: "Вход отключён на локальном стенде" } }),
  onAuthStateChange: (listener: Parameters<NonNullable<typeof appointmentCreateFixture>["onAuthStateChange"]>[0]) => appointmentCreateFixture
    ? appointmentCreateFixture.onAuthStateChange(listener) : { data: { subscription: { unsubscribe() {} } } },
  signOut: async () => ({ error: null }),
} };
export const verifyCurrentPassword = async () => false;
const auth = {
  session: { user: { id: "fixture-user" } }, isLoading: false, isDemoMode: false, isStaffMode: false, isImpersonation: false,
  user: { id: "fixture-user", email: "test@example.invalid", user_metadata: { full_name: "Тестовый владелец" } },
  userRole: assignedLeadFixture ? "lead_manager" : fixtureRole === "admin" ? "admin" : "owner",
  workspacePurpose: mortgageFixture ? "mortgage_leads" : "clinic_services",
  vertical: "beauty", clinicId: workspaceId, availableWorkspaces: [],
  rolePermissions: assignedLeadFixture
    ? { crm: true, booking: false, clients: false, leads: true, sales: false, tasks: false, dashboard: false, admin: false }
    : { booking: true, clients: true, leads: true, sales: true, tasks: true, dashboard: true, admin: true },
  signOut: async () => {}, clearWorkspaceSelection() {},
};
// Keep useAuth a plain mutable mock: the fixture parent subscribes to rerender React.
appointmentCreateFixture?.bindAuth(({ actorId, role }) => {
  auth.user.id = actorId;
  auth.session.user.id = actorId;
  auth.userRole = role;
  auth.workspacePurpose = "clinic_services";
});
export const useAuth = () => auth;
export const clearCrmCache = () => {};
export const crmErrorMessage = (status?: unknown) => window.location.pathname === "/operator" && status === 403
  ? "Недостаточно прав для этого действия." : "Изменения отключены на локальном стенде";
export const apiUrl = (path: string) => path;
export const API_BASE_URL = "";
export const publicApiUrl = apiUrl;
export class CrmApiError extends Error {}
export const crmJson = (response: Response) => response.json();
export const crmRequest = async (input?: string, init?: RequestInit) => {
  if (!mortgageFixture || !input || new URL(input, "http://fixture.invalid").pathname !== "/api/crm/whatsapp-channels") {
    throw new CrmApiError("Изменения отключены на стенде");
  }
  const response = await crmFetch(input, init);
  if (!response.ok) throw new CrmApiError("Изменения отключены на стенде");
  return response.json();
};
let fixtureWhatsAppEnabled = true;
export async function crmFetch(input: string, init?: ClinicArrivalGuardedInit): Promise<Response> {
  const url = new URL(input, "http://fixture.invalid");
  if (url.origin !== "http://fixture.invalid" || !url.pathname.startsWith("/api/crm/")) throw new Error("External request forbidden");
  if (appointmentCreateFixture && (init?.method || "GET").toUpperCase() !== "GET") {
    return isAppointmentCreateFixtureLocation(window.location)
      ? appointmentCreateFixture.request(url, init) : Response.json({ success: false }, { status: 403 });
  }
  if (window.location.pathname === "/clinic-arrival") return clinicArrivalFixture
    ? clinicArrivalFixture.request(url, init) : Response.json({ success: false }, { status: 403 });
  if (retryFixture && url.pathname === "/api/crm/appointments" && init?.method === "POST") {
    return retryFixture.send(JSON.parse(String(init.body)));
  }
  // In-memory visual simulation only, not evidence of a server commit.
  if (saleRetryFixture && url.pathname === "/api/crm/deals" && init?.method === "POST") {
    return saleRetryFixture.send(JSON.parse(String(init.body)));
  }
  const resource = url.pathname.split("/").at(-1) || "";
  if (window.location.pathname === "/operator") return operatorDispatchFixture
    ? operatorDispatchFixture.request(url, init) : operatorFixture.request(url, init);
  if (mortgageFixture && resource === "whatsapp-channels") {
    if (!["owner", "admin"].includes(auth.userRole)) return Response.json({ success: false }, { status: 403 });
    const channel = { id: "00000000-0000-4000-8000-000000000071", provider: "wazzup", keyMasked: "••••0071",
      enabled: fixtureWhatsAppEnabled, leadsFiled: 12, repeatsSeen: 3, lastInboundAt: `${today}T10:00:00+05:00` };
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      if (body.id !== channel.id || body.provider !== channel.provider || body.enabled !== false) {
        return Response.json({ success: false }, { status: 400 });
      }
      fixtureWhatsAppEnabled = false;
      return Response.json({ success: true, mode: "supabase", data: { item: { id: channel.id, enabled: false } } });
    }
    if (init?.method && init.method !== "GET") return Response.json({ success: false }, { status: 403 });
    return Response.json({ success: true, mode: "supabase", data: { channels: [channel] } });
  }
  if(mortgageFixture && resource==='mortgage-workspace')return mortgageBrowserRequest(url,init,auth.userRole);
  if (mortgageFixture && ['mortgage-contracts', 'mortgage-results'].includes(resource)) {
    const response = await mortgageBrowserRequest(new URL('/api/crm/mortgage-workspace', url.origin), undefined, auth.userRole);
    if (!response.ok) return response;
    const snapshot = (await response.json()).data as MortgageSnapshot;
    return mortgageOutcomesBrowserRequest(url, init, auth.userRole, snapshot);
  }
  if(mortgageFixture && resource==='leads')return mortgageLeadBrowserRequest(init,auth.userRole);
  if(mortgageFixture && resource==='auth-context')return Response.json({success:true,mode:'supabase',data:{
    workspaceId,purpose:'mortgage_leads',isAdmin:['owner','admin'].includes(auth.userRole),role:auth.userRole,
    staffUserId:auth.userRole==='admin'?mortgageFixtureAdmin.id:'00000000-0000-4000-8000-000000000010',
  }});
  if(mortgageFixture && resource==='staff'){
    if(!['owner','admin'].includes(auth.userRole))return Response.json({error:'Доступ закрыт'},{status:403});
    const staff=[{id:'00000000-0000-4000-8000-000000000010',name:'Тестовый владелец',role:'owner'},
      {id:'00000000-0000-4000-8000-000000000011',name:'Тестовый администратор',role:'admin'},
      ...teamMembers.slice(0,2).map(m=>({id:m.staffId,name:m.name,role:m.role}))]
      .map((m,i)=>({...m,email:`fixture-${i}@example.invalid`,phone:'',status:'active'}));
    return Response.json({success:true,mode:'supabase',data:{staff,items:staff,directoryAvailable:true}});
  }
  if (init?.method && init.method !== "GET") return Response.json({ success: false, error: "Изменения отключены на стенде" }, { status: 403 });
  if (assignedLeadFixture && !["leads", "lead-stages", "lead-sources"].includes(resource)) {
    return Response.json({ success: false, error: "Доступ закрыт на изолированном стенде" }, { status: 403 });
  }
  if (resource === "lead-team-analytics") {
    if (!mortgageFixture || !["owner", "admin"].includes(auth.userRole)) return Response.json({ success: false }, { status: 403 });
    const days = Number(url.searchParams.get("days") || 30);
    if (![7, 30, 90].includes(days)) return Response.json({ success: false }, { status: 400 });
    const snapshotResponse = await mortgageBrowserRequest(new URL(`/api/crm/mortgage-workspace?days=${days}`, url.origin), undefined, auth.userRole);
    const snapshot = (await snapshotResponse.json()).data as MortgageSnapshot;
    const members = snapshot.members.map((member) => {
      const mine = snapshot.contacts.filter((contact) => contact.responsibleUserId === member.id);
      const assigned = { total: mine.length, new: 0, inProgress: 0, booked: 0, lost: 0, other: 0 };
      for (const contact of mine) {
        const bucket = contact.status === "new" ? "new" : contact.status === "in_progress" ? "inProgress"
          : contact.status === "booked" ? "booked" : contact.status === "lost" ? "lost" : "other";
        assigned[bucket] += 1;
      }
      return { staffId: member.id, name: member.name, role: member.role, status: member.status, assigned,
        activity: { updatedEvents: 0, createdEvents: 0, touchedLeads: 0, lastRecordedAt: null } };
    });
    const generatedAt = new Date().toISOString();
    return Response.json({ success: true, mode: "supabase", data: { analytics: {
      generatedAt, period: { days, from: new Date(Date.parse(generatedAt) - days * 86_400_000).toISOString(), to: generatedAt },
      totalLeads: snapshot.metrics.totalLeads, unassignedLeads: snapshot.metrics.unassignedLeads,
      otherAssigneeLeads: snapshot.contacts.filter((contact) => contact.responsibleUserId && !members.some((member) => member.staffId === contact.responsibleUserId)).length,
      activityStatus: "available", members,
    } } });
  }
  if (mortgageFixture && resource === "lead-assignees") {
    return Response.json({ success: true, mode: "supabase", data: {
      assignees: [...teamMembers.filter((member) => member.status === "active").map((member) => ({ id: member.staffId, name: member.name })),
        ...(auth.userRole === "admin" ? [{ id: mortgageFixtureAdmin.id, name: mortgageFixtureAdmin.name }] : [])],
    } });
  }
  let items = lists[resource] || [];
  if (resource === "clients" && url.searchParams.has("search")) {
    const query = url.searchParams.get("search")!.toLocaleLowerCase("ru");
    items = items.filter((item: any) => item.name.toLocaleLowerCase("ru").includes(query));
  }
  return Response.json({ success: true, mode: "supabase", data: { items, [keys[resource] || resource]: items, directoryAvailable: true, timeZone: fixtureTimeZone } });
}

// Only the disposable loopback origin receives these fabricated identifiers.
localStorage.setItem("negis_workspace_selector", workspaceId);
window.fetch = async () => { throw new Error("Network disabled in visual fixture"); };
