import assert from "node:assert/strict";
import test from "node:test";

const { parseOperatorBooking, parseOperatorBookingContext } = await import(
  new URL("../../lib/crm/operator-contracts.ts", import.meta.url).href
) as {
  parseOperatorBooking(value: unknown, key: string, zone: string): Record<string, unknown> | null;
  parseOperatorBookingContext(value: unknown): { timeZone: string | null } | null;
};
const key = "00000000-0000-4000-8000-0000000052a1", zone = "Asia/Almaty";
const value = { id: key, startsAt: "2030-01-07T10:00:00+05:00", service: "Owned service", doctorName: "Owned doctor",
  priceMinor: "150050", durationMinutes: 75, status: "scheduled", timeZone: zone };
const read = (patch: Record<string, unknown> = {}) => parseOperatorBooking({ ...value, ...patch }, key, zone);

test("booking receipt accepts native offsets/microseconds and safe existing status results", () => {
  for (const startsAt of [value.startsAt, "2030-01-07T05:00:00Z", "2030-01-07T05:00:00.123456Z", "2030-01-07T05:00:00-03:30"])
    assert.equal(read({ startsAt })?.startsAt, startsAt);
  for (const status of ["scheduled", "confirmed", "arrived", "no_show", "cancelled"]) assert.equal(read({ status })?.status, status);
  assert.equal(read({ startsAt: "2030-01-08T10:00:00+05:00", status: "confirmed" })?.status, "confirmed",
    "A legitimate existing appointment may have been rescheduled; identity remains the original key");
});
test("booking receipt copies only its safe DTO and never mutates the source or rounds KZT", () => {
  const source = { ...value, notes: "private-note", clientPhone: "private-phone", auth_user_id: "private-identity" };
  assert.deepEqual(parseOperatorBooking(source, key, zone), value);
  assert.equal(source.clientPhone, "private-phone");
  for (const priceMinor of ["0", "1", "150050", "10000000000"]) assert.equal(read({ priceMinor })?.priceMinor, priceMinor);
});
test("booking receipt supports explicitly cleared or extended existing metadata without changing creation limits", () => {
  for (const field of ["startsAt", "service", "doctorName", "priceMinor", "durationMinutes", "status"])
    assert.equal(read({ [field]: null })?.[field], null, field);
  assert.equal(read({ service: "", doctorName: " " })?.service, "");
  for (const priceMinor of ["10000000001", "9223372036854775807"]) assert.equal(read({ priceMinor })?.priceMinor, priceMinor);
  for (const durationMinutes of [720, 2147483647]) assert.equal(read({ durationMinutes })?.durationMinutes, durationMinutes);
});
test("booking receipt must match both the original key and original time-zone label", () => {
  assert.equal(parseOperatorBooking(value, "00000000-0000-4000-8000-000000005202", zone), null);
  assert.equal(parseOperatorBooking(value, key, "UTC"), null);
  assert.equal(read({ timeZone: "Asia/Qyzylorda" }), null);
  assert.deepEqual(parseOperatorBooking({ ...value, id: key.toUpperCase() }, key.toUpperCase(), zone), value);
});
test("booking receipt rejects noncanonical/unsafe prices and invalid duration bounds", () => {
  for (const priceMinor of [1, "", " 100", "100\n", "-1", "01", "1.5", "1e3", "9223372036854775808"])
    assert.equal(read({ priceMinor }), null, String(priceMinor));
  for (const durationMinutes of [0, -1, 2147483648, 1.5, "75", NaN, Infinity]) assert.equal(read({ durationMinutes }), null);
  assert.equal(read({ durationMinutes: 600 })?.durationMinutes, 600);
});
test("booking receipt refuses impossible calendar days, unzoned/invalid times and malformed zones", () => {
  for (const startsAt of ["2030-01-07T10:00:00", "2030-02-30T10:00:00Z", "2030-02-29T10:00:00Z", "2030-01-07T24:00:00Z",
    "2030-01-07T10:60:00Z", "2030-01-07T10:00:60Z", "2030-01-07T10:00:00+25:00", "2030-01-07T10:00:00Z\n", "0000-01-01T10:00:00Z"])
    assert.equal(read({ startsAt }), null, String(startsAt));
  assert.ok(read({ startsAt: "2032-02-29T10:00:00Z" }));
  for (const timeZone of [null, "", "Invalid/Zone", "UTC\n", " UTC", "+05:00", 5]) assert.equal(read({ timeZone }), null);
});
test("booking receipt refuses absent fields, unknown status and unprintable placeholder objects", () => {
  for (const field of Object.keys(value)) assert.equal(read({ [field]: undefined }), null, field);
  for (const patch of [{ service: {} }, { doctorName: [] }, { status: "paid" }, { status: "constructor" }]) assert.equal(read(patch), null);
  for (const raw of [null, undefined, [], key, false]) assert.equal(parseOperatorBooking(raw, key, zone), null);
});
test("booking context distinguishes unconfigured null from invalid metadata and strips extras", () => {
  assert.deepEqual(parseOperatorBookingContext({ timeZone: null, private: "not-returned" }), { timeZone: null });
  for (const timeZone of [zone, "UTC", "Etc/GMT-5"]) assert.deepEqual(parseOperatorBookingContext({ timeZone }), { timeZone });
  for (const raw of [null, undefined, {}, [], { timeZone: "" }, { timeZone: "Invalid/Zone" }, { timeZone: 5 }, { timeZone: "UTC\n" }])
    assert.equal(parseOperatorBookingContext(raw), null);
});
