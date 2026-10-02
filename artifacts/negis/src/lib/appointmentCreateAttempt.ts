export type AppointmentCreateAttempt = {
  workspaceId: string;
  actorId: string;
  requestKey: string;
  payload: Record<string, unknown>;
  uncertain: boolean;
};

export function newAppointmentCreateAttempt(
  workspaceId: string, actorId: string, payload: Record<string, unknown>,
  makeKey: () => string = () => crypto.randomUUID(),
): AppointmentCreateAttempt {
  if (!workspaceId || !actorId) throw new Error("Не удалось определить аккаунт записи. Войдите снова.");
  const { id: _localId, requestKey: _suppliedKey, ...fields } = payload;
  return { workspaceId, actorId, requestKey: makeKey(), uncertain: false,
    payload: JSON.parse(JSON.stringify(fields)) as Record<string, unknown> };
}

export function isCurrentAppointmentAttempt(attempt: AppointmentCreateAttempt, workspaceId: string, actorId: string): boolean {
  return attempt.workspaceId === workspaceId && attempt.actorId === actorId;
}

export function canReleaseAppointmentAttempt(attempt: AppointmentCreateAttempt, status: number, body: unknown): boolean {
  // A later refusal cannot disprove an earlier uncertain commit.
  if (attempt.uncertain || !body || typeof body !== "object") return false;
  const result = body as Record<string, unknown>;
  if (result.success !== false) return false;
  if ([400, 401, 403, 422].includes(status)) return true;
  if (status === 409 && ["appointment_conflict", "outside_doctor_schedule", "arrival_payment"].includes(String(result.code))) return true;
  return status === 503 && result.code === "appointment_create_unavailable";
}

export function confirmedAppointmentCreate(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const result = body as Record<string, unknown>;
  const data = result.data as Record<string, unknown> | undefined;
  const item = data?.item as Record<string, unknown> | undefined;
  if (result.success !== true || result.mode !== "supabase" || typeof data?.replayed !== "boolean"
    || typeof item?.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)) return null;
  return item;
}

export function mergeCreatedAppointment<T extends { id: string }>(items: T[], saved: T): T[] {
  const index = items.findIndex(item => item.id === saved.id);
  if (index < 0) return [saved, ...items];
  return items.flatMap((item, current) => item.id !== saved.id ? [item] : current === index ? [saved] : []);
}
