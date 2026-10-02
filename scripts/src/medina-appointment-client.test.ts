import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type ClientFields = { clientId: string; client: string; phone: string; whatsapp: string };
const moduleUrl = new URL("../../artifacts/negis/src/lib/appointmentClient.ts", import.meta.url);
const { editAppointmentClient, selectAppointmentClient } = await import(moduleUrl.href) as {
  editAppointmentClient<T extends ClientFields>(current: T, field: "client" | "phone" | "whatsapp", value: string): T;
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
