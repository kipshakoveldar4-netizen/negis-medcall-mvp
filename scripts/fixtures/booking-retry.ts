// A deterministic UI simulation, never evidence of database persistence.
export function createBookingRetryFixture() {
  let firstBody = "";
  let calls = 0;
  let saved: Record<string, unknown> | null = null;
  return {
    stats: () => ({ calls, rows: saved ? 1 : 0 }),
    async send(body: Record<string, unknown>) {
      calls++;
      if (typeof body.requestKey !== "string") throw new Error("Fixture requires a request key");
      if (!saved) {
        firstBody = JSON.stringify(body);
        saved = { ...body, id: "00000000-0000-4000-8000-000000000090" };
        throw new Error("Fixture: reply lost after simulated save");
      }
      if (JSON.stringify(body) !== firstBody) return Response.json({ success: false, code: "appointment_request_conflict", error: "Fixture request changed" }, { status: 409 });
      return Response.json({ success: true, mode: "supabase", data: { item: saved, clientCreated: true, replayed: true } });
    },
  };
}
