import type { ReactNode } from "react";

export const reportIds = {
  A: "11111111-1111-4111-8111-111111111111",
  B: "22222222-2222-4222-8222-222222222222",
  W1: "aaaaaaaa-1111-4111-8111-111111111111",
  W2: "bbbbbbbb-2222-4222-8222-222222222222",
} as const;
type Actor = "A" | "B";
type Role = "owner" | "admin" | "lead_manager";
const listeners = new Set<() => void>();
const authListeners = new Set<(event: string, session: ReturnType<typeof session>) => void>();
let sdkActor: Actor = "A";
let actor: Actor = "A";
let role: Role = "owner";
let workspace: "W1" | "W2" = "W1";
const roles: Record<Actor, Role> = { A: "owner", B: "owner" };
const workspaces: Record<Actor, "W1" | "W2"> = { A: "W1", B: "W1" };
let revision = 0;
let snapshot = makeSnapshot();
function selectFixtureWorkspace() {
  if (typeof window !== "undefined") window.localStorage.setItem("negis_workspace_selector", reportIds[workspace]);
}
selectFixtureWorkspace();
function session() {
  return { user: { id: reportIds[sdkActor], email: `qa-reports-${sdkActor.toLowerCase()}@example.invalid` },
    access_token: `fixture-ads-${sdkActor}` };
}
function makeSnapshot() { return { actor, sdkActor, role, workspace, revision }; }
function changed() { selectFixtureWorkspace(); snapshot = makeSnapshot(); for (const listener of listeners) listener(); }
function sdkEvent(next: Actor, event = "SIGNED_IN") {
  sdkActor = next;
  revision++;
  for (const listener of [...authListeners]) listener(event, session());
}
export const reportsAuthFixture = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => snapshot,
  switchActor() { sdkEvent(actor === "A" ? "B" : "A"); actor = sdkActor; role = roles[actor]; workspace = workspaces[actor]; changed(); },
  switchSdkOnly() { sdkEvent(sdkActor === "A" ? "B" : "A"); changed(); },
  acceptSdk() { actor = sdkActor; role = roles[actor]; workspace = workspaces[actor]; changed(); },
  switchABA() { const original = sdkActor; sdkEvent(original === "A" ? "B" : "A"); sdkEvent(original); changed(); },
  refresh() { sdkEvent(sdkActor, "TOKEN_REFRESHED"); changed(); },
  role(next: Role) { roles[actor] = next; role = next; revision++; changed(); },
  workspace(next: "W1" | "W2") { workspaces[actor] = next; workspace = next; revision++; changed(); },
  reset() { roles.A = roles.B = "owner"; workspaces.A = workspaces.B = "W1"; sdkEvent("A"); actor = "A"; role = "owner"; workspace = "W1"; changed(); },
};
export const hasSupabaseFrontendEnv = true;
export const arrivedByRecoveryLink = false;
export const supabase = { auth: {
  getSession: async () => ({ data: { session: session() }, error: null }),
  onAuthStateChange(listener: (event: string, value: ReturnType<typeof session>) => void) {
    authListeners.add(listener);
    return { data: { subscription: { unsubscribe() { authListeners.delete(listener); } } } };
  },
} };
// Preserve synthetic observer behavior; no native auth persistence is modeled.
export const sessionAuth = { onAuthStateChange: supabase.auth.onAuthStateChange };
export function useAuth() {
  return { user: { id: reportIds[actor], email: `qa-reports-${actor.toLowerCase()}@example.invalid`, user_metadata: { full_name: `QA отчёты ${actor}` } },
    session: { user: { id: reportIds[actor] } }, userRole: role, clinicId: reportIds[workspace],
    workspacePurpose: "clinic_services", vertical: "clinic", isLoading: false, isSigningOut: false,
    isDemoMode: false, isImpersonation: false, isStaffMode: true };
}
// Layout is deliberately excluded: the two real report pages and transport are unchanged.
export function PageLayout({ children }: { children: ReactNode }) {
  return <main className="negis-app-shell min-h-full bg-[var(--negis-ground)]">{children}</main>;
}
