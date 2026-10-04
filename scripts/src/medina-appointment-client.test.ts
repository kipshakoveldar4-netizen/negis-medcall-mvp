import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type ClientFields = { clientId: string; client: string; phone: string; whatsapp: string };
const moduleUrl = new URL("../../artifacts/negis/src/lib/appointmentClient.ts", import.meta.url);
const { editAppointmentClient, matchesAppointmentClientHistory, selectAppointmentClient } = await import(moduleUrl.href) as {
  editAppointmentClient<T extends ClientFields>(current: T, field: "client" | "phone" | "whatsapp", value: string): T;
  matchesAppointmentClientHistory(current: Pick<ClientFields, "clientId" | "phone" | "whatsapp">, appointment: { clientId?: string | null; phone?: string | null; whatsapp?: string | null }): boolean;
  selectAppointmentClient<T extends ClientFields>(current: T, selected: { id: string; name: string; phone: string; whatsapp: string }): T;
};

const form = Object.freeze({
  clientId: "old-card",
  client: "Same name",
  phone: "+77000000001",
  whatsapp: "+77000000002",
  service: "Test service",
  priceTenge: "5000",
  doctorId: "test-master",
});

test("explicit selection replaces identity without changing service, master or price", () => {
  const selected = { id: "new-card", name: form.client, phone: "+77000000003", whatsapp: "+77000000004" };
  assert.deepEqual(selectAppointmentClient(form, selected), {
    ...form, clientId: selected.id, client: selected.name, phone: selected.phone, whatsapp: selected.whatsapp,
  });
  assert.equal(form.clientId, "old-card");
});

test("selecting a card with no contacts does not inherit the previous person's contacts", () => {
  const next = selectAppointmentClient(form, { id: "new-card", name: "New client", phone: "", whatsapp: "" });
  assert.equal(next.phone, "");
  assert.equal(next.whatsapp, "");
});

test("WhatsApp fallback belongs only to the selected card", () => {
  const next = selectAppointmentClient(form, { id: "new-card", name: "New client", phone: "+77000000003", whatsapp: "" });
  assert.equal(next.phone, "+77000000003");
  assert.equal(next.whatsapp, next.phone);
});

for (const field of ["client", "phone", "whatsapp"] as const) {
  test(`editing linked ${field} clears the link and inherited contacts`, () => {
    assert.deepEqual(editAppointmentClient(form, field, "replacement"), {
      ...form, clientId: "", phone: "", whatsapp: "", [field]: "replacement",
    });
  });
  test(`an unchanged ${field} retains explicit selection`, () => {
    assert.equal(editAppointmentClient(form, field, form[field]), form);
  });
}

test("typing a new client preserves independently entered contacts", () => {
  const unlinked = { ...form, clientId: "" };
  assert.deepEqual(editAppointmentClient(unlinked, "client", "New name"), { ...unlinked, client: "New name" });
  assert.deepEqual(editAppointmentClient(unlinked, "phone", "+77000000003"), { ...unlinked, phone: "+77000000003" });
});

test("editing phone after selection cannot leave the old WhatsApp as an identity fallback", () => {
  let next = editAppointmentClient(form, "phone", "+7");
  next = editAppointmentClient(next, "phone", "+77000000003");
  assert.equal(next.clientId, "");
  assert.equal(next.whatsapp, "");
  assert.equal(next.phone, "+77000000003");
});

test("history never uses a matching name without a card or contact", () => {
  const typed = { ...form, clientId: "", phone: "", whatsapp: "" };
  assert.equal(matchesAppointmentClientHistory(typed, form), false);
  assert.equal(matchesAppointmentClientHistory(typed, typed), false);
});

test("selected card shows its own history even after a name or contact change", () => {
  const visit = { ...form, client: "Previous name", phone: "", whatsapp: "" };
  assert.equal(matchesAppointmentClientHistory(form, visit), true);
});

test("selected card excludes another card sharing the same name and phone", () => {
  assert.equal(matchesAppointmentClientHistory(form, { ...form, clientId: "another-card" }), false);
});

for (const clientId of [undefined, null, ""]) {
  test(`selected card excludes legacy history with clientId=${String(clientId)}`, () => {
    assert.equal(matchesAppointmentClientHistory(form, { ...form, clientId }), false);
  });
}

test("switching to a namesake card rejects the previous remote history immediately", () => {
  const next = selectAppointmentClient(form, { id: "new-card", name: form.client, phone: form.phone, whatsapp: form.whatsapp });
  assert.equal(matchesAppointmentClientHistory(next, form), false);
  assert.equal(matchesAppointmentClientHistory(next, next), true);
});

test("editing a linked name removes the previous history with inherited contacts", () => {
  const next = editAppointmentClient(form, "client", "Different client");
  assert.equal(matchesAppointmentClientHistory(next, form), false);
});

test("unselected history uses the full formatted contact and existing 8-to-7 normalization", () => {
  const typed = { ...form, clientId: "", phone: "8 (700) 000-00-01", whatsapp: "" };
  assert.equal(matchesAppointmentClientHistory(typed, form), true);
  assert.equal(matchesAppointmentClientHistory(typed, { ...form, clientId: null }), true);
});

test("unselected WhatsApp-only history uses the same complete-number comparison", () => {
  const typed = { ...form, clientId: "", phone: "", whatsapp: form.phone };
  assert.equal(matchesAppointmentClientHistory(typed, form), true);
  assert.equal(matchesAppointmentClientHistory(typed, { phone: "", whatsapp: form.phone }), true);
});

test("different country codes with identical last ten digits are not the same contact", () => {
  const typed = { ...form, clientId: "", phone: "+1 700 000 0001", whatsapp: "" };
  assert.equal(matchesAppointmentClientHistory(typed, form), false);
});

test("an entered primary phone cannot fall back to an unrelated secondary contact", () => {
  const typed = { ...form, clientId: "", phone: "+77000000003", whatsapp: form.phone };
  assert.equal(matchesAppointmentClientHistory(typed, form), false);
});

test("empty, incomplete and overlong contacts cannot match history", () => {
  for (const phone of ["", "+", "+7", "700000001", "1234567890123456"]) {
    const typed = { ...form, clientId: "", phone, whatsapp: "" };
    assert.equal(matchesAppointmentClientHistory(typed, typed), false, phone);
  }
  assert.equal(matchesAppointmentClientHistory({ ...form, clientId: "" }, {}), false);
});

test("booking search only suggests cards; explicit selection and edits use tested helpers", async () => {
  const page = await readFile(new URL("../../artifacts/negis/src/pages/AppointmentsPage.tsx", import.meta.url), "utf8");
  const searchStart = page.indexOf("const query = form.client.replace");
  const searchEnd = page.indexOf("/** Full history", searchStart);
  assert.ok(searchStart > 0 && searchEnd > searchStart);
  assert.doesNotMatch(page.slice(searchStart, searchEnd), /setForm\s*\(/);
  assert.match(page, /setForm\(\(current\) => selectAppointmentClient\(current, client\)\)/);
  for (const field of ["client", "phone", "whatsapp"]) {
    assert.ok(page.includes(`editAppointmentClient(current, "${field}", ${field})`));
  }
});
