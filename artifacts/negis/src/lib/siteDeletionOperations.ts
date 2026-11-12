export type SiteDeletionIntent = { leadId: string; leadUpdatedAt: string; receiptIds: string[]; requestKey: string; confirmed: true };
export type SiteDeletionOperation = {
  workspaceId: string; actorId: string; requestKey: string; leadId: string; request: SiteDeletionIntent;
  state: "prepared" | "committed" | "abandoned"; createdAt: string; completedAt: string | null;
  acknowledgedAt: string | null; receiptsDeleted: number | null; replayed: boolean;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const timestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value) && Number.isFinite(Date.parse(value));

export function parseSiteDeletionIntent(value: unknown): SiteDeletionIntent | null {
  const row = record(value);
  if (!row || Object.keys(row).length !== 5 || row.confirmed !== true || typeof row.leadId !== "string" || !uuid.test(row.leadId)
    || typeof row.requestKey !== "string" || !uuid.test(row.requestKey) || !timestamp(row.leadUpdatedAt)
    || !Array.isArray(row.receiptIds) || row.receiptIds.length < 1 || row.receiptIds.length > 200
    || !row.receiptIds.every((id): id is string => typeof id === "string" && uuid.test(id))
    || new Set(row.receiptIds.map(id => id.toLowerCase())).size !== row.receiptIds.length) return null;
  return { leadId: row.leadId, leadUpdatedAt: row.leadUpdatedAt, receiptIds: [...row.receiptIds], requestKey: row.requestKey, confirmed: true };
}

export function siteDeletionIntentBody(value: SiteDeletionIntent) {
  return JSON.stringify({ leadId: value.leadId, leadUpdatedAt: value.leadUpdatedAt, receiptIds: value.receiptIds, requestKey: value.requestKey, confirmed: true });
}

export function parseSiteDeletionOperation(value: unknown, workspaceId: string, actorId?: string): SiteDeletionOperation | null {
  const row = record(value), request = parseSiteDeletionIntent(row?.request);
  if (!row || !request || row.workspaceId !== workspaceId.toLowerCase() || typeof row.actorId !== "string" || !uuid.test(row.actorId)
    || (actorId !== undefined && row.actorId !== actorId.toLowerCase()) || row.requestKey !== request.requestKey.toLowerCase()
    || row.leadId !== request.leadId.toLowerCase() || typeof row.replayed !== "boolean" || !timestamp(row.createdAt)
    || (row.completedAt !== null && !timestamp(row.completedAt)) || (row.acknowledgedAt !== null && !timestamp(row.acknowledgedAt))) return null;
  const { state, completedAt, acknowledgedAt, receiptsDeleted } = row;
  if (!(state === "prepared" && completedAt === null && acknowledgedAt === null && receiptsDeleted === null)
    && !(state === "committed" && completedAt !== null && receiptsDeleted === request.receiptIds.length)
    && !(state === "abandoned" && completedAt !== null && receiptsDeleted === null)) return null;
  return { workspaceId: workspaceId.toLowerCase(), actorId: row.actorId, requestKey: request.requestKey.toLowerCase(), leadId: request.leadId.toLowerCase(),
    request, state: state as SiteDeletionOperation["state"], createdAt: row.createdAt, completedAt: completedAt as string | null,
    acknowledgedAt: acknowledgedAt as string | null, receiptsDeleted: receiptsDeleted as number | null, replayed: row.replayed };
}

export function parseSiteDeletionOperationResponse(value: unknown, workspaceId: string, actorId?: string) {
  const body = record(value), data = record(body?.data);
  return body?.success === true ? parseSiteDeletionOperation(data?.operation, workspaceId, actorId) : null;
}

export function parseSiteDeletionOperations(value: unknown, workspaceId: string, actorId: string) {
  const body = record(value), data = record(body?.data);
  if (body?.success !== true || data?.complete !== true || typeof data.deletionEnabled !== "boolean" || !Array.isArray(data.operations) || data.operations.length > 64) return null;
  const items = data.operations.map(value => parseSiteDeletionOperation(value, workspaceId, actorId));
  if (items.some(value => !value || value.acknowledgedAt !== null) || new Set(items.map(value => value?.requestKey)).size !== items.length) return null;
  return { operations: items as SiteDeletionOperation[], deletionEnabled: data.deletionEnabled };
}
