import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type PlannedRole = "owner" | "admin" | "lead_manager";
type Rejection = { status: number; code: string };
type OwnerDraft = { purpose: string; vertical: string | null; ownerLogin: string; ownerLoginOnly: boolean; ownerEmail: string; ownerName: string };
type StaffDraft = { login?: string; role: string; fullName: string };

let networkAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkAttempts += 1;
  throw new Error("Baspana preparation validation must not use network");
};
test.after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkAttempts, 0, "preparation must not contact Auth or cloud APIs");
});

// Pin the source files; extensionless imports can resolve ignored build output.
const { canAssignRole } = await import(new URL("../../lib/auth/permissions.ts", import.meta.url).href) as {
  canAssignRole(actor: PlannedRole, target: PlannedRole): boolean;
};
const { emailFromLogin, isLoginShape, normalizeLogin, loginOrEmailToAuthEmail } = await import(new URL("../../lib/auth/staff-logins.ts", import.meta.url).href) as {
  emailFromLogin(login: string): string;
  isLoginShape(login: string): boolean;
  normalizeLogin(login: unknown): string;
  loginOrEmailToAuthEmail(login: unknown): string;
};
const { validateCredentialsOnboardingRequest } = await import(new URL("../../lib/crm/platform-onboarding-credentials.ts", import.meta.url).href) as {
  validateCredentialsOnboardingRequest(body: Record<string, unknown>): OwnerDraft | Rejection;
};
const { validateStaffCredentialsRequest } = await import(new URL("../../lib/crm/staff-credentials.ts", import.meta.url).href) as {
  validateStaffCredentialsRequest(body: Record<string, unknown>, actor: string): StaffDraft | Rejection;
};
const { mortgageRouteAllowed } = await import(new URL("../../lib/crm/workspace-policy.ts", import.meta.url).href) as {
  mortgageRouteAllowed(role: string, route: string, method: string): boolean;
};

const plan = JSON.parse(await readFile(new URL("../fixtures/baspana-account-preparation.json", import.meta.url), "utf8")) as {
  status: string;
  target: { environment: string; database: string; previewOrigin: string };
  company: { name: string; city: string; country: string };
  platformBusiness: { reportedName: string; website: null; websiteStatus: string; metaPortfolioId: null; verificationStatus: string };
  onboardingDraft: Record<string, unknown>;
  proposedTimeZone: string;
  accounts: { login: string; fullName: string; role: PlannedRole }[];
  assignment: { mode: string; assignedByRole: string; assigneeRole: string; managerVisibility: string; unassignedVisibleTo: string[] };
  whatsapp: { selectedApproach: string; connectionMode: string; allowApiOnly: boolean; metaAppId: string; provider: null; enabled: boolean; phoneNumberId: null; channelId: null; inboundOnly: boolean; preserveBusinessApp: boolean; importHistory: boolean };
  pending: string[];
};

test("Baspana preparation has seven exact canonical logins and no issued credentials", () => {
  assert.equal(plan.status, "prepared_not_created");
  assert.deepEqual(plan.accounts.map(account => account.login), [
    "baspana.dinara", "baspana.tolkyn", "baspana.gulnur", "baspana.adelya",
    "baspana.nesibeli", "baspana.munira", "baspana.tleugaisha",
  ]);
  assert.equal(new Set(plan.accounts.map(account => account.login)).size, 7);
  for (const account of plan.accounts) {
    assert.ok(isLoginShape(account.login));
    assert.equal(normalizeLogin(account.login), account.login);
    assert.equal(loginOrEmailToAuthEmail(account.login), emailFromLogin(account.login));
    assert.ok(account.fullName.length >= 2 && account.fullName.length <= 120);
  }
  assert.doesNotMatch(JSON.stringify(plan), /"(?:password|access_token|refresh_token|secret|apiKey|auth_user_id|workspaceId)"\s*:/i);
  assert.ok(plan.pending.includes("exact_username_availability"), "a valid shape does not establish account availability");
});

test("Baspana preparation remains an unsubmitted draft for the exact isolated Preview", () => {
  assert.equal(plan.target.environment, "preview");
  assert.equal(plan.target.database, "medina-os-site-test");
  assert.equal(plan.target.previewOrigin, "https://negis-medcall-mvp-api-server-q64dqx3xb-yeldar-s-projects.vercel.app");
  assert.ok(plan.pending.includes("isolated_control_target_and_platform_access"));
  assert.ok(plan.pending.includes("explicit_test_creation_approval"));
  assert.ok(plan.pending.includes("human_credential_entry_and_submission"));
  assert.equal(plan.onboardingDraft.timeZone, "");
  const result = validateCredentialsOnboardingRequest(plan.onboardingDraft);
  assert.ok("status" in result);
  assert.equal(result.status, 400, "unfinished business settings cannot pass onboarding validation");
  assert.ok(plan.pending.includes("time_zone_confirmation"));
});

test("The owner draft uses the dedicated username bootstrap, not a medical niche or fake personal email", () => {
  const result = validateCredentialsOnboardingRequest({ ...plan.onboardingDraft, timeZone: plan.proposedTimeZone });
  assert.ok(!("status" in result));
  assert.equal(result.purpose, "mortgage_leads");
  assert.equal(result.vertical, null);
  assert.equal(result.ownerLogin, plan.accounts[0].login);
  assert.equal(result.ownerLoginOnly, true);
  assert.equal(result.ownerEmail, loginOrEmailToAuthEmail(plan.accounts[0].login));
  assert.equal(result.ownerName, plan.accounts[0].fullName);
  assert.ok(!Object.hasOwn(plan.onboardingDraft, "ownerEmail"));
});

test("The prepared administrator and five managers respect existing server hierarchy", () => {
  assert.equal(plan.accounts.filter(account => account.role === "owner").length, 1);
  assert.equal(plan.accounts.filter(account => account.role === "admin").length, 1);
  assert.equal(plan.accounts.filter(account => account.role === "lead_manager").length, 5);
  // Only the pure validator sees this synthetic test value; no Auth request is made.
  for (const account of plan.accounts.slice(1)) {
    const actor = account.role === "admin" ? "owner" : "admin";
    const result = validateStaffCredentialsRequest({ ...account, password: "Fixture-only-123!" }, actor);
    assert.ok(!("status" in result));
    assert.equal(result.login, account.login);
    assert.equal(result.role, account.role);
    assert.equal(result.fullName, account.fullName);
    assert.ok(canAssignRole(actor, account.role));
  }
  for (const actor of ["owner", "admin"] as const) {
    const denied = validateStaffCredentialsRequest({ ...plan.accounts[0], password: "Fixture-only-123!" }, actor);
    assert.ok("status" in denied);
    assert.equal(denied.status, 403);
  }
  assert.equal(canAssignRole("admin", "admin"), false);
  for (const role of ["owner", "admin", "lead_manager"] as const) {
    assert.equal(mortgageRouteAllowed(role, "leads", "GET"), true);
  }
  assert.equal(mortgageRouteAllowed("lead_manager", "lead-assignees", "GET"), false);
  assert.equal(mortgageRouteAllowed("lead_manager", "staff-credentials", "POST"), false);
});

test("Preparation preserves manual assignment and leaves WhatsApp disconnected", () => {
  assert.deepEqual(plan.assignment, {
    mode: "manual", assignedByRole: "admin", assigneeRole: "lead_manager",
    managerVisibility: "assigned_only", unassignedVisibleTo: ["owner", "admin"],
  });
  assert.equal(plan.whatsapp.provider, null);
  assert.equal(plan.whatsapp.enabled, false);
  assert.equal(plan.whatsapp.channelId, null);
  assert.equal(plan.whatsapp.phoneNumberId, null);
  assert.equal(plan.whatsapp.inboundOnly, true);
  assert.equal(plan.whatsapp.preserveBusinessApp, true);
  assert.equal(plan.whatsapp.importHistory, false);
  assert.ok(plan.pending.includes("signed_synthetic_inbound_and_assignment_acceptance"));
});

test("Choosing direct Meta does not approve business identity, Coexistence or the shared callback", () => {
  assert.equal(plan.whatsapp.selectedApproach, "direct_meta_negis");
  assert.equal(plan.whatsapp.metaAppId, "1791176138576964");
  assert.equal(plan.whatsapp.provider, null, "the selected approach is not a connected provider");
  assert.equal(plan.whatsapp.enabled, false);
  assert.equal(plan.whatsapp.channelId, null);
  assert.equal(plan.whatsapp.phoneNumberId, null);
  for (const gate of [
    "platform_business_identity_and_portfolio",
    "meta_tech_provider_and_app_review",
    "coexistence_embedded_signup_acceptance",
    "shared_meta_callback_isolation",
    "test_channel_schema_and_permissions",
  ]) {
    assert.ok(plan.pending.includes(gate), `${gate} must remain pending after a direction choice`);
  }
  assert.equal(plan.whatsapp.preserveBusinessApp, true);
  assert.equal(plan.whatsapp.importHistory, false);
  assert.equal(plan.whatsapp.inboundOnly, true);
});

test("The reported platform business is separate from the client and remains unverified", () => {
  assert.equal(plan.platformBusiness.reportedName, "ИП Медина");
  assert.equal(plan.company.name, "Baspana ipoteka building");
  assert.notEqual(plan.platformBusiness.reportedName, plan.company.name);
  assert.notEqual(plan.platformBusiness.reportedName, "Moto Shtorm");
  assert.equal(plan.platformBusiness.website, null, "a website must not be invented");
  assert.equal(plan.platformBusiness.websiteStatus, "absent", "the owner confirmed there is no public website");
  assert.equal(plan.platformBusiness.metaPortfolioId, null, "the existing app portfolio is not assumed to belong to the platform IP");
  assert.equal(plan.platformBusiness.verificationStatus, "not_submitted");
  assert.ok(!plan.pending.includes("platform_public_website"), "website availability must not be asked again");
  assert.ok(plan.pending.includes("platform_website_requirement_or_preparation"));
  assert.ok(plan.pending.includes("platform_business_identity_and_portfolio"));
  assert.equal(plan.whatsapp.provider, null);
  assert.equal(plan.whatsapp.enabled, false);
});

test("Baspana requires Coexistence and cannot use an API-only fallback in preparation", () => {
  assert.equal(plan.whatsapp.connectionMode, "coexistence");
  assert.equal(plan.whatsapp.allowApiOnly, false);
  assert.equal(plan.whatsapp.preserveBusinessApp, true);
  assert.equal(plan.whatsapp.inboundOnly, true);
  assert.equal(plan.whatsapp.importHistory, false);
  assert.equal(plan.whatsapp.provider, null);
  assert.equal(plan.whatsapp.enabled, false);
  assert.equal(plan.whatsapp.phoneNumberId, null);
  assert.equal(plan.whatsapp.channelId, null);
  assert.ok(plan.pending.includes("coexistence_embedded_signup_acceptance"));
  assert.ok(plan.pending.includes("shared_meta_callback_isolation"));
});
