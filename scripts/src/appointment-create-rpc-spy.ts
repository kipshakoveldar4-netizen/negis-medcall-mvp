import assert from "node:assert/strict";

type Result = { data: unknown; error: unknown };
type Insert = PromiseLike<Result> & { select(columns: string): { single(): PromiseLike<Result> } };
type Update = { eq(column: string, value: unknown): Update; select(columns: string): { single(): PromiseLike<Result> } };

// For query-spy suites only: expose the RPC's writes to their existing logs and
// failure injection. Transaction rollback and SQL permissions are tested against
// the real migration in medina-arrival-payment.test.ts, not simulated here.
export function withAppointmentCreateRpcSpy<T extends { from(table: string): unknown }>(client: T) {
  const writer = client as { from(table: string): { insert(row: unknown): Insert; update(row: unknown): Update } };
  return Object.assign(client, {
    async rpc(name: string, args: Record<string, unknown>): Promise<Result> {
      assert.ok(["read_crm_appointment_request_v2", "create_crm_appointment_v2", "patch_crm_appointment_as_actor"].includes(name));
      assert.equal(typeof args.p_auth_user_id, "string");
      assert.ok(["owner", "admin", "receptionist", "manager", "doctor"].includes(String(args.p_actor_role)));
      if (name === "read_crm_appointment_request_v2") return { data: null, error: null };
      if (name === "patch_crm_appointment_as_actor") {
        const saved = await writer.from("appointments").update(args.p_patch).eq("id", args.p_appointment_id)
          .eq("workspace_id", args.p_workspace_id).select("*").single();
        if (saved.error) return saved;
        const row = Array.isArray(saved.data) ? saved.data[0] : saved.data;
        return { data: row ? { ...(args.p_before as Record<string, unknown>), ...(row as Record<string, unknown>),
          id: args.p_appointment_id, workspace_id: args.p_workspace_id } : null, error: null };
      }
      const card = args.p_new_client as Record<string, unknown> | null;
      const visit = args.p_appointment as Record<string, unknown>;
      assert.equal(visit.workspace_id, args.p_workspace_id);
      assert.equal(visit.created_by_staff_user_id, args.p_staff_user_id);
      if (card) {
        assert.equal(card.workspace_id, args.p_workspace_id);
        assert.equal(visit.client_id, card.id);
        const created = await writer.from("clients").insert(card);
        if (created.error) return created;
      }
      const saved = await writer.from("appointments").insert(visit).select("*").single();
      if (saved.error) return saved;
      // Deliberately not idempotence, authority, transaction or SQL proof.
      // These spy suites exercise only their original query/role/advisory paths.
      return { data: { appointment: Array.isArray(saved.data) ? { ...visit, id: args.p_request_key } : saved.data,
        replayed: false, clientCreated: Boolean(card), clientMatch: args.p_client_match }, error: null };
    },
  });
}
