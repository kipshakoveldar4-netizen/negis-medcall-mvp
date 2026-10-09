type MetaWorkspaceEnv = Readonly<Record<string, string | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MetaWorkspaceBoundaryError extends Error {
  constructor(
    public readonly statusCode: 403 | 503,
    public readonly code: "meta_workspace_not_provisioned" | "meta_workspace_not_authorized",
    message: string,
  ) {
    super(message);
    this.name = "MetaWorkspaceBoundaryError";
  }
}

export class MetaAccountBoundaryError extends Error {
  constructor(
    public readonly statusCode: 400 | 403 | 503,
    public readonly code:
      | "meta_account_id_required"
      | "meta_account_not_provisioned"
      | "meta_account_not_authorized",
    message: string,
  ) {
    super(message);
    this.name = "MetaAccountBoundaryError";
  }
}

export function normalizeMetaAdAccountId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/^act_/, "");
  return /^\d+$/.test(normalized) ? normalized : "";
}

/**
 * A server token and ad account belong to one explicitly provisioned workspace.
 * Workspace membership alone must never grant access to shared Meta credentials.
 */
export function requireMetaProvisionedWorkspace(
  workspaceId: string,
  env: MetaWorkspaceEnv = process.env,
): void {
  const provisionedWorkspaceId = env.META_WORKSPACE_ID?.trim() || "";
  if (!UUID.test(provisionedWorkspaceId)) {
    throw new MetaWorkspaceBoundaryError(
      503,
      "meta_workspace_not_provisioned",
      "Meta ещё не назначена рабочему пространству. Настройте серверный META_WORKSPACE_ID.",
    );
  }

  if (!UUID.test(workspaceId) || workspaceId.toLowerCase() !== provisionedWorkspaceId.toLowerCase()) {
    throw new MetaWorkspaceBoundaryError(
      403,
      "meta_workspace_not_authorized",
      "Meta не подключена для этого рабочего пространства.",
    );
  }
}

/** A persisted account record may describe only the server-side Meta account. */
export function requireMetaProvisionedAdAccount(
  adAccountId: unknown,
  env: MetaWorkspaceEnv = process.env,
): void {
  const provisionedAccountId = normalizeMetaAdAccountId(env.META_AD_ACCOUNT_ID);
  if (!provisionedAccountId) {
    throw new MetaAccountBoundaryError(
      503,
      "meta_account_not_provisioned",
      "Meta ad account ещё не настроен на сервере.",
    );
  }

  const requestedAccountId = normalizeMetaAdAccountId(adAccountId);
  if (!requestedAccountId) {
    throw new MetaAccountBoundaryError(
      400,
      "meta_account_id_required",
      "Укажите корректный Meta Ad Account ID.",
    );
  }

  if (requestedAccountId !== provisionedAccountId) {
    throw new MetaAccountBoundaryError(
      403,
      "meta_account_not_authorized",
      "Этот Meta ad account не назначен рабочему пространству.",
    );
  }
}
