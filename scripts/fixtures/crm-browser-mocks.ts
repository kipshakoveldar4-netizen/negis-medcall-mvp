import { createBookingRetryFixture } from "./booking-retry";
const retryFixture = new URLSearchParams(window.location?.search || "").get("bookingRetry") === "lost-response"
  ? createBookingRetryFixture() : null;
const workspaceId = "00000000-0000-4000-8000-000000000001";
const clientId = "00000000-0000-4000-8000-000000000002";
const doctorId = "00000000-0000-4000-8000-000000000003";
const serviceId = "00000000-0000-4000-8000-000000000004";
const appointmentId = "00000000-0000-4000-8000-000000000005";
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Almaty" });
const longName = "Тестовая Александра Константинопольская";
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
  getSession: async () => ({ data: { session: null } }),
  signInWithPassword: async () => ({ data: null, error: { message: "Вход отключён на локальном стенде" } }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
} };
export const verifyCurrentPassword = async () => false;
const auth = {
  session: { user: { id: "fixture-user" } }, isLoading: false, isDemoMode: false, isStaffMode: false, isImpersonation: false,
  user: { id: "fixture-user", email: "test@example.invalid", user_metadata: { full_name: "Тестовый владелец" } },
  userRole: "owner", vertical: "beauty", clinicId: workspaceId, availableWorkspaces: [],
  rolePermissions: { booking: true, clients: true, leads: true, sales: true, tasks: true, dashboard: true, admin: true },
  signOut: async () => {}, clearWorkspaceSelection() {},
};
export const useAuth = () => auth;
export const clearCrmCache = () => {};
export const crmErrorMessage = () => "Изменения отключены на локальном стенде";
export const apiUrl = (path: string) => path;
export const API_BASE_URL = "";
export const publicApiUrl = apiUrl;
export class CrmApiError extends Error {}
export const crmJson = (response: Response) => response.json();
export const crmRequest = async () => { throw new CrmApiError("Изменения отключены на стенде"); };
export async function crmFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "http://fixture.invalid");
  if (url.origin !== "http://fixture.invalid" || !url.pathname.startsWith("/api/crm/")) throw new Error("External request forbidden");
  if (retryFixture && url.pathname === "/api/crm/appointments" && init?.method === "POST") {
    return retryFixture.send(JSON.parse(String(init.body)));
  }
  if (init?.method && init.method !== "GET") return Response.json({ success: false, error: "Изменения отключены на стенде" }, { status: 403 });
  const resource = url.pathname.split("/").at(-1) || "";
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
