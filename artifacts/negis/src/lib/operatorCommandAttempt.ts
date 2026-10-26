import type { OperatorCommandAction } from "../../../../lib/crm/operator-contracts";

export type OperatorCommandAttempt = {
  actorId: string;
  workspaceId: string | null;
  channel: "proposal" | "transition";
  commandId: string;
  action: OperatorCommandAction;
  targetId: string;
};
export type OperatorCommandStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type StoredCommand = { attempt: OperatorCommandAttempt | null; error: string };
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const keys = ["actorId", "workspaceId", "channel", "commandId", "action", "targetId"];
const unavailable = "Не удалось сохранить безопасный ключ отправки. Новая отправка заблокирована.";
export function operatorCommandStorage(): OperatorCommandStorage | null {
  try { return window.sessionStorage; } catch { return null; }
}
function key(actorId: string, workspaceId: string | null, channel: OperatorCommandAttempt["channel"]) {
  return `medina_operator_command_v1:${actorId}:${workspaceId ?? "operator"}:${channel}`;
}
function valid(value: unknown): value is OperatorCommandAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === keys.length && keys.every(name => Object.hasOwn(row, name))
    && uuid(row.actorId) && (row.workspaceId === null || uuid(row.workspaceId)) && uuid(row.commandId) && uuid(row.targetId)
    && typeof row.action === "string"
    && (row.channel === "proposal" ? row.workspaceId !== null && row.action === "propose"
      : row.channel === "transition" && (row.workspaceId ? ["withdraw", "end"] : ["accept", "decline", "end"]).includes(row.action));
}
export function restoreOperatorCommand(storage: OperatorCommandStorage | null, actorId: string,
  workspaceId: string | null, channel: OperatorCommandAttempt["channel"]): StoredCommand {
  if (!storage || !uuid(actorId) || (workspaceId !== null && !uuid(workspaceId))) return { attempt: null, error: unavailable };
  try {
    const serialized = storage.getItem(key(actorId, workspaceId, channel));
    if (serialized === null) return { attempt: null, error: "" };
    const value: unknown = serialized.length <= 2048 ? JSON.parse(serialized) : null;
    if (!valid(value) || value.actorId !== actorId || value.workspaceId !== workspaceId || value.channel !== channel)
      return { attempt: null, error: "Ключ прежней отправки повреждён. Новая отправка заблокирована; требуется проверка." };
    return { attempt: { ...value }, error: "" };
  } catch { return { attempt: null, error: unavailable }; }
}
export function persistOperatorCommand(storage: OperatorCommandStorage | null, attempt: OperatorCommandAttempt): boolean {
  if (!storage || !valid(attempt)) return false;
  try {
    const name = key(attempt.actorId, attempt.workspaceId, attempt.channel), serialized = JSON.stringify(attempt);
    if (storage.getItem(name) !== null) return false;
    storage.setItem(name, serialized);
    return storage.getItem(name) === serialized;
  } catch { return false; }
}
export function clearOperatorCommand(storage: OperatorCommandStorage | null, attempt: OperatorCommandAttempt): boolean {
  if (!storage || !valid(attempt)) return false;
  try {
    const name = key(attempt.actorId, attempt.workspaceId, attempt.channel);
    if (storage.getItem(name) !== JSON.stringify(attempt)) return false;
    storage.removeItem(name);
    return storage.getItem(name) === null;
  } catch { return false; }
}
