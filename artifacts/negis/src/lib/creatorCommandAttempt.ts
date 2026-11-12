import { parseCreatorCommandIdentity, parseCreatorJobAction, parseCreatorJobTerms,
  type CreatorCommandIdentity, type CreatorJobAction, type CreatorJobTerms } from "../../../../lib/crm/creator-job-contracts";

export type CreatorWrite = { action: "create"; terms: CreatorJobTerms }
  | ({ jobId: string; revision: string } & CreatorJobAction);
export type CreatorCommandAttempt = CreatorCommandIdentity & { actorId: string; workspaceId: string | null };
export type CreatorCommandStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const exact = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
const unavailable = "Не удалось сохранить ключ отправки. Новая отправка заблокирована.";
const damaged = "Ключ прежней отправки повреждён. Новая отправка заблокирована; обратитесь в поддержку.";
function allowed(action: string, workspaceId: string | null) {
  return (workspaceId === null ? ["accept", "decline", "submit"] : ["create", "request_changes", "approve", "cancel"]).includes(action);
}
export function parseCreatorWrite(value: unknown, workspaceId: string | null): CreatorWrite | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || (workspaceId !== null && !uuid(workspaceId))) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.action !== "string" || !allowed(row.action, workspaceId)) return null;
  if (row.action === "create") {
    const terms = parseCreatorJobTerms(row.terms);
    return exact(row, ["action", "terms"]) && terms ? { action: "create", terms } : null;
  }
  const command = parseCreatorJobAction({ action: row.action, payload: row.payload });
  return exact(row, ["jobId", "revision", "action", "payload"]) && uuid(row.jobId) && uuid(row.revision) && command
    ? { jobId: row.jobId, revision: row.revision, ...command } : null;
}
export function creatorCommandStorage(): CreatorCommandStorage | null {
  try { return window.sessionStorage; } catch { return null; }
}
function key(actorId: string, workspaceId: string | null) { return `medina_creator_command_v1:${actorId}:${workspaceId ?? "creator"}`; }
function valid(value: unknown): value is CreatorCommandAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exact(row, ["actorId", "workspaceId", "requestId", "action", "targetId"]) && uuid(row.actorId)
    && (row.workspaceId === null || uuid(row.workspaceId))
    && Boolean(parseCreatorCommandIdentity({ requestId: row.requestId, action: row.action, targetId: row.targetId }))
    && allowed(String(row.action), row.workspaceId as string | null);
}
export function restoreCreatorCommand(storage: CreatorCommandStorage | null, actorId: string, workspaceId: string | null): { attempt: CreatorCommandAttempt | null; error: string } {
  if (!storage || !uuid(actorId) || (workspaceId !== null && !uuid(workspaceId))) return { attempt: null, error: unavailable };
  try {
    const raw = storage.getItem(key(actorId, workspaceId));
    if (raw === null) return { attempt: null, error: "" };
    let value: unknown = null;
    try { if (raw.length <= 2048) value = JSON.parse(raw); } catch { return { attempt: null, error: damaged }; }
    if (!valid(value) || value.actorId !== actorId || value.workspaceId !== workspaceId)
      return { attempt: null, error: damaged };
    return { attempt: { ...value }, error: "" };
  } catch { return { attempt: null, error: unavailable }; }
}
export function persistCreatorCommand(storage: CreatorCommandStorage | null, attempt: CreatorCommandAttempt) {
  if (!storage || !valid(attempt)) return false;
  try {
    const name = key(attempt.actorId, attempt.workspaceId), raw = JSON.stringify(attempt);
    if (storage.getItem(name) !== null) return false;
    storage.setItem(name, raw);
    return storage.getItem(name) === raw;
  } catch { return false; }
}
export function clearCreatorCommand(storage: CreatorCommandStorage | null, attempt: CreatorCommandAttempt) {
  if (!storage || !valid(attempt)) return false;
  try {
    const name = key(attempt.actorId, attempt.workspaceId);
    if (storage.getItem(name) !== JSON.stringify(attempt)) return false;
    storage.removeItem(name);
    return storage.getItem(name) === null;
  } catch { return false; }
}

export function creatorFeeToMinor(value: string): string | null {
  if (!/^\d{1,17}([.,]\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().replace(",", ".").split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return amount > 0n && amount <= 9223372036854775807n ? String(amount) : null;
}
export function creatorDueAt(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const local = `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return local === value && date.getFullYear() > 0 ? date.toISOString() : null;
}
