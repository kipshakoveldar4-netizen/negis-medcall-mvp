import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Medina OS Commercial-1: the clinic-facing product must not advertise
// unfinished modules, leak internal release engineering, or show old branding.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

const admin = await readFile(path.join(negisSrc, "pages", "AdminCenter.tsx"), "utf8");
const sidebar = await readFile(path.join(negisSrc, "components", "layout", "Sidebar.tsx"), "utf8");
const mobileNav = await readFile(path.join(negisSrc, "components", "layout", "MobileNav.tsx"), "utf8");
const acc = await readFile(path.join(negisSrc, "pages", "AiControlCenter.tsx"), "utf8");
const adsAutomation = await readFile(path.join(negisSrc, "pages", "AdsAutomation.tsx"), "utf8");

test("01 no visible «скоро» teasers in clinic-facing navigation or settings", () => {
  for (const [name, source] of [["AdminCenter", admin], ["Sidebar", sidebar], ["MobileNav", mobileNav]] as const) {
    assert.ok(!source.includes("скоро"), `${name} must not advertise unfinished modules`);
  }
});

test("02 no internal release engineering on the clinic settings surface", () => {
  assert.ok(!admin.includes("Release-ready"), "old internal page title removed");
  assert.ok(!admin.includes("Release readiness"), "English readiness metric removed from clinic overview");
  assert.ok(!admin.includes("Critical blockers"), "English blockers metric removed from clinic overview");
  assert.ok(!admin.includes("· blockers"), "raw blockers counter removed");
});

test("03 clinic settings page is titled and branded for clinics", () => {
  assert.ok(admin.includes("Настройки клиники"));
  assert.ok(admin.includes("Администрирование"));
  assert.ok(!admin.includes("Admin OS"), "old Admin OS branding removed");
  assert.ok(!admin.includes("Negis OS"), "old Negis OS branding removed from AdminCenter");
});

test("04 internal diagnostics stay available behind progressive disclosure", () => {
  assert.ok(admin.includes("Диагностика платформы · внутренний раздел Medina Platform"));
  assert.ok(admin.includes("<details"), "platform diagnostics use progressive disclosure");
  assert.ok(admin.includes("ReleaseBanner readiness={readiness}"), "release diagnostics preserved for platform staff");
  assert.ok(admin.includes("Готовность платформы:"), "readiness wording is Russian");
});

test("05 session-expired presentation is professional and non-technical", () => {
  assert.ok(admin.includes("Сессия завершена"));
  assert.ok(admin.includes("Для защиты данных необходимо войти в аккаунт повторно."));
  assert.ok(admin.includes("Войти снова"));
  assert.ok(!admin.includes("Supabase-сессия"), "provider internals are not shown to customers");
});

test("06 customer navigation lists only working modules", () => {
  for (const demoRoute of ['"/reception"', '"/calls"', '"/tasks"', '"/chat"', '"/market"', '"/reports"']) {
    assert.ok(!mobileNav.includes(demoRoute), `mobile drawer must not advertise demo route ${demoRoute}`);
    assert.ok(!sidebar.includes(demoRoute), `sidebar must not advertise demo route ${demoRoute}`);
  }
  assert.ok(mobileNav.includes('"/sales"') && mobileNav.includes("Продажи"));
});

test("07 Medina OS branding is present on customer routes", () => {
  assert.ok(sidebar.includes("Medina OS"));
  assert.ok(acc.includes("Medina OS"));
  assert.ok(!acc.includes("Negis OS"));
});

test("08 Ads Automation PAUSED safety remains intact", () => {
  assert.ok(adsAutomation.includes("Все рекламные кампании, созданные через Negis OS.") || adsAutomation.includes("выключенной"), "history subtitle present");
  assert.ok(acc.includes("Реклама в Medina OS создаётся выключенной. Включить её можно вручную в Meta Ads Manager."));
});

test("09 no fake billing or checkout surfaces exist", () => {
  for (const [name, source] of [["AdminCenter", admin], ["Sidebar", sidebar]] as const) {
    assert.ok(!/checkout|Оплатить картой|invoice/i.test(source), `${name} must not fake billing`);
  }
});
