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
  platformBusiness: {
    reportedName: string;
    publicLegalName: string;
    website: string;
    websiteStatus: string;
    metaPortfolioId: string;
    metaPortfolioStatus: string;
    metaAppPortfolioLinkStatus: string;
    verificationStatus: string;
    verificationEvidence: string;
    verificationObservedOn: string;
    verificationNote: string;
    phoneEvidenceStatus: string;
    phoneEvidenceNote: string;
  };
  onboardingDraft: Record<string, unknown>;
  ownerBootstrapAcceptance: { status: string; scope: string; release: string; acceptedOn: string };
  confirmedTimeZone: string;
  timeZoneConfirmedOn: string;
  accounts: { login: string; fullName: string; role: PlannedRole }[];
  assignment: { mode: string; assignedByRole: string; assigneeRole: string; managerVisibility: string; unassignedVisibleTo: string[] };
  whatsapp: { selectedApproach: string; connectionMode: string; allowApiOnly: boolean; metaAppId: string; provider: null; enabled: boolean; phoneNumberId: null; channelId: null; inboundOnly: boolean; preserveBusinessApp: boolean; importHistory: boolean };
  pending: string[];
  whatsappPending: string[];
};

test("Baspana preparation has seven exact canonical logins and no issued credentials", () => {
  assert.equal(plan.status, "prepared_not_created");
  assert.deepEqual(plan.accounts.map(account => account.login), [
    "baspana.dinara", "baspana.tolkyn", "baspana.gulnur", "baspana.adelya",
    "baspana.nesibeli", "baspana.munira", "baspana.tleugaisha",
  ]);
  assert.equal(new Set(plan.accounts.map(account => account.login)).size, 7);
  assert.deepEqual(plan.accounts.map(account => account.fullName), [
    "Динара", "Турсын Толкын", "Танетова Гульнур", "Кажыгалиева Аделя",
    "Ахметова Несибели", "Айтмухамедова Мунира", "Накишева Тлеугайша",
  ]);
  for (const account of plan.accounts) {
    assert.ok(isLoginShape(account.login));
    assert.equal(normalizeLogin(account.login), account.login);
    assert.equal(loginOrEmailToAuthEmail(account.login), emailFromLogin(account.login));
    assert.ok(account.fullName.length >= 2 && account.fullName.length <= 120);
  }
  assert.doesNotMatch(JSON.stringify(plan), /"(?:password|access_token|refresh_token|secret|apiKey|auth_?(?:user_?)?id|workspace_?id)"\s*:/i);
  assert.ok(plan.pending.includes("exact_username_availability"), "a valid shape does not establish account availability");
});

test("Baspana preparation remains an unsubmitted draft for the exact isolated Preview", () => {
  assert.equal(plan.target.environment, "preview");
  assert.equal(plan.target.database, "medina-os-site-test");
  assert.equal(plan.target.previewOrigin, "https://negis-medcall-mvp-api-server-git-codex-200904-yeldar-s-projects.vercel.app");
  assert.deepEqual(plan.pending, [
    "isolated_control_target_and_platform_access",
    "exact_production_release_and_required_schema_approval",
    "real_baspana_workspace_and_seven_account_creation_confirmation",
    "human_credential_entry_and_submission",
    "exact_username_availability",
  ], "account creation has its own approval queue without Meta or WhatsApp blockers");
  assert.deepEqual(plan.ownerBootstrapAcceptance, {
    status: "accepted", scope: "test_owner_only", release: "9a9d25a", acceptedOn: "2026-10-14",
  });
  assert.ok(!plan.pending.includes("mortgage_onboarding_acceptance"));
  assert.ok(!plan.whatsappPending.includes("mortgage_onboarding_acceptance"));
});

test("The owner-confirmed Baspana time zone is recorded without submitting the account draft", () => {
  assert.equal(plan.confirmedTimeZone, "Asia/Almaty");
  assert.equal(plan.timeZoneConfirmedOn, "2026-10-15");
  assert.equal(plan.onboardingDraft.timeZone, plan.confirmedTimeZone);
  assert.ok(!plan.pending.includes("time_zone_confirmation"));
  assert.equal(plan.status, "prepared_not_created");
  assert.ok(plan.pending.includes("real_baspana_workspace_and_seven_account_creation_confirmation"));
  assert.ok(plan.pending.includes("human_credential_entry_and_submission"));
  const missingTimeZone = validateCredentialsOnboardingRequest({ ...plan.onboardingDraft, timeZone: "" });
  assert.ok("status" in missingTimeZone);
  assert.equal(missingTimeZone.status, 400, "the confirmed draft must not remove the server's time-zone requirement");
});

test("The owner draft uses the dedicated username bootstrap, not a medical niche or fake personal email", () => {
  const result = validateCredentialsOnboardingRequest(plan.onboardingDraft);
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
  assert.ok(plan.whatsappPending.includes("signed_synthetic_inbound_and_assignment_acceptance"));
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
    assert.ok(plan.whatsappPending.includes(gate), `${gate} must remain pending after a direction choice`);
  }
  assert.equal(plan.whatsapp.preserveBusinessApp, true);
  assert.equal(plan.whatsapp.importHistory, false);
  assert.equal(plan.whatsapp.inboundOnly, true);
});

test("The owner-authorized public platform business is separate from the client and remains unverified", () => {
  assert.deepEqual(plan.platformBusiness, {
    reportedName: "ИП Медина",
    publicLegalName: "ИП КЫПШАКОВА ДИАНА КИЯСКЫЗЫ",
    website: "https://medinaos.com",
    websiteStatus: "published_pending_meta_acceptance",
    metaPortfolioId: "1694609597992242",
    metaPortfolioStatus: "owner_confirmed_unverified",
    metaAppPortfolioLinkStatus: "not_confirmed",
    verificationStatus: "in_review",
    verificationEvidence: "live_meta_security_center",
    verificationObservedOn: "2026-10-15",
    verificationNote: "Security Center shows the full public legal name and an in-review status with an estimate of about two business days; verification is not approved.",
    phoneEvidenceStatus: "owner_reports_phone_confirmation",
    phoneEvidenceNote: "Owner reports personally confirming the WhatsApp number; exact integration scope is unknown and no connection is confirmed.",
  });
  assert.equal(plan.company.name, "Baspana ipoteka building");
  assert.notEqual(plan.platformBusiness.reportedName, plan.company.name);
  assert.notEqual(plan.platformBusiness.reportedName, "Moto Shtorm");
  assert.ok(!plan.pending.includes("platform_public_website"), "website availability must not be asked again");
  assert.ok(!plan.pending.includes("platform_website_requirement_or_preparation"), "the published website replaces the preparation gate with Meta acceptance");
});

test("Live Meta review and owner-reported phone confirmation do not block accounts or authorize WhatsApp", () => {
  assert.equal(plan.platformBusiness.websiteStatus, "published_pending_meta_acceptance");
  assert.equal(plan.platformBusiness.metaPortfolioStatus, "owner_confirmed_unverified");
  assert.equal(plan.platformBusiness.verificationStatus, "in_review");
  assert.equal(plan.platformBusiness.verificationEvidence, "live_meta_security_center");
  assert.equal(plan.platformBusiness.phoneEvidenceStatus, "owner_reports_phone_confirmation");
  assert.equal(plan.platformBusiness.metaAppPortfolioLinkStatus, "not_confirmed", "selecting a portfolio does not confirm app linkage or transfer ownership");
  const whatsappGates = [
    "platform_website_meta_acceptance",
    "platform_business_identity_and_portfolio",
    "platform_phone_ownership_evidence",
    "meta_app_portfolio_link_confirmation",
    "meta_tech_provider_and_app_review",
    "coexistence_embedded_signup_acceptance",
    "shared_meta_callback_isolation",
    "test_channel_schema_and_permissions",
    "signed_synthetic_inbound_and_assignment_acceptance",
  ];
  assert.deepEqual(plan.whatsappPending, whatsappGates, "all existing WhatsApp gates remain separate from account creation");
  for (const gate of whatsappGates) {
    assert.ok(!plan.pending.includes(gate), `${gate} must not block the seven accounts`);
  }
  assert.equal(plan.status, "prepared_not_created");
  assert.equal(plan.whatsapp.selectedApproach, "direct_meta_negis");
  assert.equal(plan.whatsapp.metaAppId, "1791176138576964");
  assert.equal(plan.whatsapp.provider, null);
  assert.equal(plan.whatsapp.enabled, false);
  assert.equal(plan.whatsapp.phoneNumberId, null);
  assert.equal(plan.whatsapp.channelId, null);
  assert.equal(plan.whatsapp.connectionMode, "coexistence");
  assert.equal(plan.whatsapp.allowApiOnly, false);
  assert.equal(plan.whatsapp.preserveBusinessApp, true);
  assert.equal(plan.whatsapp.inboundOnly, true);
  assert.equal(plan.whatsapp.importHistory, false);
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
  assert.ok(plan.whatsappPending.includes("coexistence_embedded_signup_acceptance"));
  assert.ok(plan.whatsappPending.includes("shared_meta_callback_isolation"));
});
