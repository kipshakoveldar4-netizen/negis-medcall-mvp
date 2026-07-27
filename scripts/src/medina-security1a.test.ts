import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Medina OS Security-1A — the frontend must not depend on database tables that
// do not exist in the production Supabase project.
//
// Verified absent in production (public schema): agents, bookings, shifts,
// user_roles, clinics, roles, ad_accounts, ad_reports, platform_configs,
// wz_messages. Verified present: leads, clients, appointments, deals,
// staff_users, workspaces (all reached through server-authorized /api/crm).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

const MISSING_TABLES = [
  "agents",
  "bookings",
  "shifts",
  "user_roles",
  "clinics",
  "roles",
  "ad_accounts",
  "ad_reports",
  "platform_configs",
  "wz_messages",
];

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const sourceFiles = await collectSourceFiles(negisSrc);
const sources = new Map<string, string>();
for (const file of sourceFiles) sources.set(file, await readFile(file, "utf8"));

const app = await readFile(path.join(negisSrc, "App.tsx"), "utf8");
const sidebar = await readFile(path.join(negisSrc, "components", "layout", "Sidebar.tsx"), "utf8");
const mobileNav = await readFile(path.join(negisSrc, "components", "layout", "MobileNav.tsx"), "utf8");
const topbar = await readFile(path.join(negisSrc, "components", "layout", "Topbar.tsx"), "utf8");
const authContext = await readFile(path.join(negisSrc, "contexts", "AuthContext.tsx"), "utf8");
const dashboard = await readFile(path.join(negisSrc, "pages", "Dashboard.tsx"), "utf8");
const fbPixel = await readFile(path.join(negisSrc, "components", "FbPixelInit.tsx"), "utf8");

test("01 the router has no active /agent route", () => {
  assert.ok(!app.includes('path="/agent"'), "/agent route removed");
  assert.ok(!/ROUTE_PERMISSIONS[\s\S]*'\/agent'/.test(app), "/agent has no route permission entry");
});

test("02 Agent.tsx is deleted and never imported", async () => {
  assert.equal(await exists(path.join(negisSrc, "pages", "Agent.tsx")), false);
  for (const [file, source] of sources) {
    assert.ok(!/from ["']@\/pages\/Agent["']/.test(source), `${path.basename(file)} must not import Agent`);
  }
});

test("03 navigation exposes no /agent entry", () => {
  for (const [name, source] of [["Sidebar", sidebar], ["MobileNav", mobileNav], ["Topbar", topbar]] as const) {
    assert.ok(!source.includes("/agent"), `${name} must not link to /agent`);
  }
});

test("04-06 no frontend file queries a nonexistent table", () => {
  for (const [file, source] of sources) {
    for (const table of MISSING_TABLES) {
      assert.ok(
        !source.includes(`.from('${table}')`) && !source.includes(`.from("${table}")`),
        `${path.relative(negisSrc, file)} must not query missing table "${table}"`,
      );
    }
  }
});

test("07 AuthContext resolves access through the server, not legacy tables", () => {
  assert.ok(!authContext.includes("supabase.from("), "AuthContext performs no direct table reads");
  assert.ok(authContext.includes("/api/crm/staff"), "workspace/role come from the server API");
  assert.ok(authContext.includes("applyNoWorkspaceAccess"), "unlinked accounts get no role");
  // An account with no clinic link must not be silently elevated.
  assert.ok(!/applyNoWorkspaceAccess[\s\S]{0,400}ALL_PERMISSIONS/.test(authContext));
});

test("08 no frontend file queries the clinics table", () => {
  for (const [file, source] of sources) {
    assert.ok(!source.includes("'clinics'"), `${path.relative(negisSrc, file)} must not reference clinics`);
  }
});

test("09 no Supabase Realtime channel targets a legacy table", () => {
  for (const [file, source] of sources) {
    assert.ok(!source.includes(".channel("), `${path.relative(negisSrc, file)} must not open a realtime channel`);
    assert.ok(!source.includes("postgres_changes"), `${path.relative(negisSrc, file)} must not subscribe to table changes`);
  }
  assert.ok(!topbar.includes("Bell"), "the bell implying live booking alerts is gone");
});

test("10 the dashboard uses only real server-authorized CRM endpoints", () => {
  for (const endpoint of ["/api/crm/appointments", "/api/crm/leads", "/api/crm/clients", "/api/crm/deals"]) {
    assert.ok(dashboard.includes(endpoint), `dashboard should read ${endpoint}`);
  }
  assert.ok(!dashboard.includes("useGetDashboardMetrics"), "the missing /api/dashboard/metrics hook is gone");
  assert.ok(!dashboard.includes("Гонка агентов"), "employee race widget removed");
  assert.ok(dashboard.includes("ok: false"), "failed reads stay honest rather than defaulting to 0");
});

test("11 no customer copy advertises shift tracking or payroll", () => {
  for (const [file, source] of sources) {
    for (const phrase of ["Моя смена", "Смена начата", "Смена завершена", "Заработано", "weekly_target"]) {
      assert.ok(!source.includes(phrase), `${path.relative(negisSrc, file)} must not advertise "${phrase}"`);
    }
  }
});

test("12 removed modules are not replaced by «скоро» teasers", () => {
  for (const [name, source] of [["App", app], ["Sidebar", sidebar], ["MobileNav", mobileNav]] as const) {
    assert.ok(!source.includes("скоро"), `${name} must not show a coming-soon placeholder`);
  }
});

test("13 supported CRM routes remain registered", () => {
  for (const route of ["/leads", "/clients", "/appointments", "/sales", "/ads-automation", "/admin", "/onboarding"]) {
    assert.ok(app.includes(`path="${route}"`), `${route} must remain routed`);
  }
});

test("14 Ads Automation and its PAUSED safety are untouched", async () => {
  const ads = await readFile(path.join(negisSrc, "pages", "AdsAutomation.tsx"), "utf8");
  assert.ok(ads.includes("выключенной"), "PAUSED notice preserved");
  assert.ok(app.includes('path="/ads-automation"') && app.includes('path="/ads-automation/history"'));
});

test("15 the legacy ad cabinet is gone and its links redirect to the supported module", async () => {
  assert.equal(await exists(path.join(negisSrc, "pages", "Ads.tsx")), false);
  assert.equal(await exists(path.join(negisSrc, "pages", "AdsCallback.tsx")), false);
  assert.ok(!app.includes('path="/ads"'), "legacy /ads route removed");
  assert.ok(app.includes('path="/advertising"') && app.includes('<Redirect to="/ads-automation" />'));
});

test("16 the Meta Pixel stays disabled without a supported configuration source", () => {
  assert.ok(!fbPixel.includes("initPixel("), "no pixel is initialised from a missing table");
  assert.ok(!fbPixel.includes("supabase"), "no direct table lookup remains");
  assert.ok(fbPixel.includes("return null"));
});

test("17 demo mode remains explicitly labelled", () => {
  assert.ok(sidebar.includes("Демо-режим"));
  assert.ok(dashboard.includes("Демо-режим"));
});

test("18 /agent and /register fall through to the intentional not-found route", () => {
  assert.ok(app.includes("<Route component={NotFound} />"), "catch-all not-found route present");
  assert.ok(!app.includes('path="/register"'), "dead self-signup route removed");
});

test("19 orphaned legacy helpers are deleted", async () => {
  for (const orphan of [
    path.join(negisSrc, "lib", "agentDisplay.ts"),
    path.join(negisSrc, "hooks", "useWazzupInbox.ts"),
    path.join(negisSrc, "lib", "conversion.ts"),
    path.join(negisSrc, "pages", "Register.tsx"),
  ]) {
    assert.equal(await exists(orphan), false, `${path.basename(orphan)} should be removed`);
  }
});
