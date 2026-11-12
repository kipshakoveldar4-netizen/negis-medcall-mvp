import * as importedBrief from "../../lib/advertising/campaignBrief";
import * as importedCities from "../../lib/meta/cities";

const { ADVERTISING_CAMPAIGN_PREFILL_KEY, ADVERTISING_CONTENT_STUDIO_PREFILL_KEY, parseAdvertisingCampaignPrefillForPlatform }
  = ((importedBrief as { default?: unknown }).default ?? importedBrief) as typeof import("../../lib/advertising/campaignBrief");
const { KZ_META_CITY_OPTIONS } = ((importedCities as { default?: unknown }).default ?? importedCities) as typeof import("../../lib/meta/cities");

export const advertisingDemoFixtureIds = Object.freeze({
  workspace: "advertising-browser-demo", demoUser: "demo-user",
  A: "advertising-fixture-sdk-A", B: "advertising-fixture-sdk-B",
});

type Actor = "A" | "B";
type FixtureSession = { user: { id: string }; access_token: string };
type AuthListener = (event: string, session: FixtureSession | null) => void;
type FixtureLocation = { protocol?: string; hostname?: string; pathname?: string; search?: string; hash?: string };
const goalKeys = ["schemaVersion", "platform", "sourceModule", "sourceKind", "campaignName", "service", "city", "cityId",
  "targetPatients", "durationDays", "maxBudget", "dailyBudget", "budgetCurrency", "generatedAt"];

export function isAdvertisingDemoFixtureLocation(location: FixtureLocation) {
  return location.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname || "")
    && location.pathname === "/ads" && location.search === "?advertising=demo" && !location.hash;
}

// Only the fixed demo scope is read; never inspect an unscoped or UUID draft.
export function readAdvertisingDemoGoalPrefill(storage: Pick<Storage, "getItem">, destination: string) {
  const key = destination === "/content-studio" ? ADVERTISING_CONTENT_STUDIO_PREFILL_KEY
    : destination === "/ads-automation" ? ADVERTISING_CAMPAIGN_PREFILL_KEY : null;
  if (!key) return null;
  try {
    if (storage.getItem("negis_workspace_selector") !== advertisingDemoFixtureIds.workspace) return null;
    const raw = storage.getItem(`${key}::${advertisingDemoFixtureIds.workspace}`);
    if (!raw || raw.length > 10_000) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== goalKeys.length || !goalKeys.every((field) => Object.hasOwn(record, field))
      || record.schemaVersion !== 1 || record.platform !== "meta" || record.sourceModule !== "advertising-hub"
      || record.sourceKind !== "goal" || record.budgetCurrency !== "USD") return null;
    for (const field of ["campaignName", "service", "city", "cityId", "generatedAt"]) {
      if (typeof record[field] !== "string" || !record[field].trim() || record[field].length > 2_000) return null;
    }
    const parsed = parseAdvertisingCampaignPrefillForPlatform(value, "meta");
    if (!parsed || parsed.targetPatients !== record.targetPatients || !Number.isSafeInteger(parsed.targetPatients) || !parsed.targetPatients || parsed.targetPatients < 0
      || parsed.durationDays !== record.durationDays || !Number.isSafeInteger(parsed.durationDays) || !parsed.durationDays || parsed.durationDays < 0 || parsed.durationDays > 90
      || !parsed.maxBudget || !parsed.dailyBudget || parsed.dailyBudget !== Math.round(parsed.maxBudget / parsed.durationDays * 100) / 100
      || !parsed.generatedAt || !Number.isFinite(Date.parse(parsed.generatedAt))
      || parsed.campaignName !== `${parsed.service} · ${parsed.city}`
      || !KZ_META_CITY_OPTIONS.some((city) => city.id === parsed.cityId && city.labelRu === parsed.city)) return null;
    // Project only the validated goal contract, not assets, approvals or legacy fields.
    return Object.freeze(Object.fromEntries(goalKeys.map((field) => [field, parsed[field as keyof typeof parsed]])));
  } catch { return null; }
}

// Independent cached SDK state: it never changes the explicit demo AuthContext.
export function createAdvertisingDemoBrowserFixture() {
  let actor: Actor = "A", revision = 0, refreshes = 0, authEvents = 0, initialSessions = 0;
  let registrations = 0, unsubscriptions = 0, pendingInitialCallbacks = 0, canceledInitialCallbacks = 0;
  let sdkReads = 0, calls = 0, networkCalls = 0, blocked = 0;
  const listeners = new Set<() => void>(), authListeners = new Map<number, AuthListener>();
  const session = (): FixtureSession => ({ user: { id: advertisingDemoFixtureIds[actor] }, access_token: `invalid-local-advertising-${actor}-${refreshes}` });
  const readSnapshot = () => Object.freeze({
    sdkActor: actor, sdkActorId: advertisingDemoFixtureIds[actor], demoUserId: advertisingDemoFixtureIds.demoUser,
    workspaceId: advertisingDemoFixtureIds.workspace, revision, refreshes, authEvents, initialSessions,
    registrations, unsubscriptions, listeners: authListeners.size, pendingInitialCallbacks, canceledInitialCallbacks,
    sdkReads, calls, networkCalls, blocked,
  });
  let snapshot = readSnapshot();
  const emit = () => { snapshot = readSnapshot(); for (const listener of listeners) listener(); };
  const emitAuth = (event: string) => {
    authEvents++;
    for (const [id, listener] of [...authListeners]) {
      if (authListeners.has(id)) listener(event, session());
    }
  };
  const changeActor = (next: Actor) => { actor = next; revision++; emitAuth("SIGNED_IN"); };

  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    session,
    async getSession(): Promise<{ data: { session: FixtureSession | null }; error: null }> {
      sdkReads++; blocked++; emit(); throw new Error("TEST: advertising demo SDK lookup denied");
    },
    onAuthStateChange(listener: AuthListener) {
      const id = ++registrations;
      let active = true, pending = true;
      authListeners.set(id, listener); pendingInitialCallbacks++; emit();
      queueMicrotask(() => {
        if (!active) return;
        pending = false; pendingInitialCallbacks--; initialSessions++; authEvents++;
        try { listener("INITIAL_SESSION", session()); } finally { emit(); }
      });
      return { data: { subscription: { unsubscribe() {
        if (!active) return;
        active = false; authListeners.delete(id); unsubscriptions++;
        if (pending) { pending = false; pendingInitialCallbacks--; canceledInitialCallbacks++; }
        emit();
      } } } };
    },
    switchActor() { changeActor(actor === "A" ? "B" : "A"); emit(); },
    switchABA() {
      if (actor !== "A") return;
      // Both raw events precede the one parent-render notification.
      changeActor("B"); changeActor("A"); emit();
    },
    refreshSameActor() { refreshes++; emitAuth("TOKEN_REFRESHED"); emit(); },
    async request(): Promise<Response> {
      calls++; blocked++; emit();
      return Response.json({ success: false, error: "TEST: advertising demo CRM denied" }, { status: 403 });
    },
    async denyNetwork(): Promise<never> {
      networkCalls++; blocked++; emit(); throw new Error("Network disabled in visual fixture");
    },
  };
}
