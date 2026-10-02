import assert from "node:assert/strict";

type Result = { data: unknown; error: unknown };
type Insert = PromiseLike<Result> & { select(columns: string): { single(): PromiseLike<Result> } };

// For query-spy suites only: expose the RPC's writes to their existing logs and
// failure injection. Transaction rollback and SQL permissions are tested against
// the real migration in medina-arrival-payment.test.ts, not simulated here.
export function withAppointmentCreateRpcSpy<T extends { from(table: string): unknown }>(client: T) {
  const writer = client as { from(table: string): { insert(row: unknown): Insert } };
  return Object.assign(client, {
    async rpc(name: string, args: Record<string, unknown>): Promise<Result> {
      assert.equal(name, "create_crm_appointment_with_new_client");
      const card = args.p_client as Record<string, unknown>;
      const visit = args.p_appointment as Record<string, unknown>;
      assert.equal(card.workspace_id, args.p_workspace_id);
      assert.equal(visit.workspace_id, args.p_workspace_id);
      assert.equal(visit.client_id, card.id);
      const created = await writer.from("clients").insert(card);
      if (created.error) return created;
      return await writer.from("appointments").insert(visit).select("*").single();
    },
  });
}
