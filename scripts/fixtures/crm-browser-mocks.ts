import { createBookingRetryFixture } from "./booking-retry";
import { createOperatorBrowserFixture } from "./operator-browser-store";
import { createOperatorDispatchFixture } from "./operator-dispatch-fixture";
import { mortgageBrowserRequest, mortgageLeadBrowserRequest } from './mortgage-browser-store';
const retryFixture = new URLSearchParams(window.location?.search || "").get("bookingRetry") === "lost-response"
  ? createBookingRetryFixture() : null;
const fixtureParams = new URLSearchParams(window.location?.search || "");
// Keep explicit visual-test settings across local page reloads, not CRM data.
for (const key of ["fixtureRole", "fixturePurpose"]) {
  const value = fixtureParams.get(key);
  if (value) sessionStorage.setItem(`medina-visual:${key}`, value);
  else if (sessionStorage.getItem(`medina-visual:${key}`)) fixtureParams.set(key, sessionStorage.getItem(`medina-visual:${key}`)!);
}
const fixtureRole = fixtureParams.get("fixtureRole");
const assignedLeadFixture = fixtureRole === "lead_manager";
const mortgageFixture = fixtureParams.get("fixturePurpose") === "mortgage_leads";
const operatorFixture = createOperatorBrowserFixture();
export const operatorDispatchFixture = fixtureParams.get("operatorDispatch") === "deferred"
  ? createOperatorDispatchFixture((url, init) => operatorFixture.request(url, init)) : null;
export const suspendOperatorFixture = () => operatorFixture.suspend();
export const endOperatorCooperationFixture = () => operatorFixture.endCooperation();
const workspaceId = "00000000-0000-4000-8000-000000000001";
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
const appointment = { id: appointmentId, clientId, client: longName, client_name: longName, phone: client.phone, client_phone: client.phone, whatsapp: client.whatsapp, doctorId, doctor: "Тестовый специалист", doctor_name: "Тестовый специалист", service, service_name: service, serviceId, startsAt: `${today}T10:00:00+05:00`, starts_at: `${today}T10:00:00+05:00`, durationMinutes: 90, priceMinor: 1250000, status: "confirmed", notes: "Вымышленная запись для проверки вёрстки" };
const lists: Record<string, unknown[]> = {
  appointments: [appointment],
  clients: [client, { ...client, id: "00000000-0000-4000-8000-000000000006", name: "Тестовая Мария", full_name: "Тестовая Мария", fullName: "Тестовая Мария", phone: "+77000000002" }],
  deals: [{ id: "00000000-0000-4000-8000-000000000007", clientId, client: longName, client_name: longName, title: service, service, service_name: service, amountMinor: 1250000, amount_minor: 1250000, currency: "KZT", status: "paid", paidAt: `${today}T10:00:00+05:00`, createdAt: `${today}T10:00:00+05:00` }],
  leads: [{ id: "00000000-0000-4000-8000-000000000008", client: longName, client_name: longName, name: longName, phone: client.phone, service, source: "Тестовая реклама", status: "new", createdAt: new Date().toISOString() }],
  "clinic-doctors": [{ id: doctorId, fullName: "Тестовый специалист", specialty: "Тестовый прайс", isActive: true }],
  "clinic-services": [{ id: serviceId, name: service, doctorId, basePriceMinor: 1250000, durationMinutes: 90, isActive: true }],
};
const keys: Record<string, string> = { "clinic-doctors": "doctors", "clinic-services": "services", "doctor-shifts": "shifts" };
export const hasSupabaseFrontendEnv = true;
export const arrivedByRecoveryLink = false;
export const supabase = { auth: {
  getSession: async () => ({ data: { session: ["/admin", "/operator"].includes(window.location.pathname)
    ? { user: { id: window.location.pathname === "/operator" ? "00000000-0000-4000-8000-000000000805" : "fixture-user" }, access_token: "visual-fixture-not-a-valid-token" } : null } }),
  signInWithPassword: async () => ({ data: null, error: { message: "Вход отключён на локальном стенде" } }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
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
export async function crmFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "http://fixture.invalid");
  if (url.origin !== "http://fixture.invalid" || !url.pathname.startsWith("/api/crm/")) throw new Error("External request forbidden");
  if (retryFixture && url.pathname === "/api/crm/appointments" && init?.method === "POST") {
    return retryFixture.send(JSON.parse(String(init.body)));
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
  if(mortgageFixture && resource==='leads')return mortgageLeadBrowserRequest(init,auth.userRole);
  if(mortgageFixture && resource==='auth-context')return Response.json({success:true,mode:'supabase',data:{
    workspaceId,isAdmin:['owner','admin'].includes(auth.userRole),role:auth.userRole,staffUserId:'00000000-0000-4000-8000-000000000010',
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
    const generatedAt = new Date().toISOString();
    return Response.json({ success: true, mode: "supabase", data: { analytics: {
      generatedAt, period: { days, from: new Date(Date.parse(generatedAt) - days * 86_400_000).toISOString(), to: generatedAt },
      totalLeads: 7, unassignedLeads: 1, otherAssigneeLeads: 1, activityStatus: "available", members: teamMembers,
    } } });
  }
  if (mortgageFixture && resource === "lead-assignees") {
    return Response.json({ success: true, mode: "supabase", data: {
      assignees: teamMembers.filter((member) => member.status === "active").map((member) => ({ id: member.staffId, name: member.name })),
    } });
  }
  let items = lists[resource] || [];
  if (resource === "clients" && url.searchParams.has("search")) {
    const query = url.searchParams.get("search")!.toLocaleLowerCase("ru");
    items = items.filter((item: any) => item.name.toLocaleLowerCase("ru").includes(query));
  }
  return Response.json({ success: true, mode: "supabase", data: { items, [keys[resource] || resource]: items, directoryAvailable: true, timeZone: "Asia/Almaty" } });
}

// Only the disposable loopback origin receives these fabricated identifiers.
localStorage.setItem("negis_workspace_selector", workspaceId);
window.fetch = async () => { throw new Error("Network disabled in visual fixture"); };
