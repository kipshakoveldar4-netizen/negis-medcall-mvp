import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Medina OS Commercial-2: onboarding honesty, role gating, optional
// advertising, and the manager-assisted pilot state. Source-level assertions —
// they pin the behaviors that make the onboarding sellable without fakery.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

const onboarding = await readFile(path.join(negisSrc, "pages", "Onboarding.tsx"), "utf8");
const admin = await readFile(path.join(negisSrc, "pages", "AdminCenter.tsx"), "utf8");
const acc = await readFile(path.join(negisSrc, "pages", "AiControlCenter.tsx"), "utf8");

test("01 the old fake onboarding wizard is gone", () => {
  assert.ok(!onboarding.includes("In a real app"), "fake completion comment removed");
  assert.ok(!onboarding.includes("Настройка завершена!"), "unconditional success toast removed");
  assert.ok(!onboarding.includes("requireAuth={false}"), "onboarding is an authenticated experience");
});

test("02 onboarding derives step status from real existing endpoints", () => {
  for (const endpoint of ["/api/crm/admin-settings", "/api/crm/staff", "/api/crm/leads", "/api/crm/health"]) {
    assert.ok(onboarding.includes(endpoint), `onboarding must check ${endpoint}`);
  }
  assert.ok(onboarding.includes('"done" : "todo"'), "statuses derive from data, not navigation");
  assert.ok(onboarding.includes("Не удалось проверить"), "failed checks are honest, not assumed complete");
});

test("03 opening the page never marks steps complete", () => {
  assert.ok(!onboarding.includes("localStorage.setItem"), "onboarding writes no browser completion flags");
  assert.ok(onboarding.includes("Открытие этой страницы не отмечает шаги выполненными."));
});

test("04 ordinary employees do not get clinic-wide setup", () => {
  assert.ok(onboarding.includes("isClinicAdmin"));
  assert.ok(onboarding.includes("Настройку клиники выполняет администратор"));
});

test("05 advertising is optional and stays PAUSED", () => {
  assert.ok(onboarding.includes("optional: true"));
  assert.ok(onboarding.includes("необязательно"));
  assert.ok(onboarding.includes("Кампании создаются выключенными и включаются вручную в Meta Ads Manager."));
});

test("06 onboarding copy matches the commercial spec", () => {
  assert.ok(onboarding.includes("Настроим Medina OS для вашей клиники"));
  assert.ok(onboarding.includes("Клиника готова к работе"));
  assert.ok(onboarding.includes("Перейти на главную"));
  assert.ok(!onboarding.includes("скоро"));
});

test("07 the dashboard reminder is dismiss-only convenience", () => {
  assert.ok(acc.includes("negis_onboarding_hint_dismissed"));
  assert.ok(acc.includes("Dismissal only hides this"), "dismissal is documented as non-authoritative");
  assert.ok(!onboarding.includes("negis_onboarding_hint_dismissed"), "onboarding completion ignores the hint flag");
});

test("08 pilot status makes no payment claims", () => {
  assert.ok(admin.includes("Тариф и подключение"));
  assert.ok(admin.includes("Автоматическая оплата пока не подключена"));
  for (const forbidden of ["Активная подписка", "Оплачено", "checkout", "invoice", "Оплатить картой"]) {
    assert.ok(!admin.includes(forbidden), `pilot card must not claim ${forbidden}`);
  }
});

test("09 support surface has no fabricated contacts", () => {
  assert.ok(admin.includes("Связь с Medina OS"));
  assert.ok(admin.includes("Скопировать идентификатор клиники"), "the support action is a real copy action");
  for (const fake of ["mailto:", "wa.me", "t.me/", "tel:"]) {
    assert.ok(!admin.includes(fake), `no invented support contact via ${fake}`);
  }
});

test("10 demo workspace is labelled honestly in pilot status", () => {
  assert.ok(admin.includes('workspaceId === "demo-workspace" ? "Демо-режим" : "Пилотное подключение"'));
});
