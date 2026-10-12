// This role is deliberately separate from the existing clinic-wide manager.
export function isAssignedLeadRole(role: unknown): boolean {
  return role === "lead_manager";
}

export function assignedLeadRouteAllowed(route: string, method: string): boolean {
  return (route === "leads" && (method === "GET" || method === "PATCH"))
    || ((route === "lead-stages" || route === "lead-sources") && method === "GET");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields: Record<string, [string, number]> = {
  name: ["full_name", 500], fullName: ["full_name", 500], full_name: ["full_name", 500],
  phone: ["phone", 100], notes: ["notes", 10000], status: ["status", 100],
  stageId: ["stage_id", 36], stage_id: ["stage_id", 36],
};

// No ignored fields: even an unchanged assignee/client/source is forbidden.
export function assignedLeadPatch(body: Record<string, unknown>): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return null;
    const field = fields[key];
    if (!field || (value !== null && typeof value !== "string")) return null;
    const [column, limit] = field;
    if (column in patch) return null;
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length > limit) return null;
    if (column === "stage_id" && !UUID.test(text)) return null;
    if (column === "status" && !text) return null;
    patch[column] = text || null;
  }
  return Object.keys(patch).length ? patch : null;
}
