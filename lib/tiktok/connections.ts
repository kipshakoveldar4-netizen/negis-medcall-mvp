import { getSupabaseServerClient } from "../supabase/server";
import { getTikTokAdsConfig, validateTikTokAdsConnection, type TikTokAdsConnectionDiagnostic } from "./diagnostics";

type Env = Readonly<Record<string, string | undefined>>;
export type TikTokConnectionRow = {
  workspace_id: string;
  advertiser_id: string;
  currency: string;
  account_timezone: string;
  enabled: boolean;
  verified_at: string;
};
export type TikTokConnectionSummary = {
  state: "not_connected" | "connected" | "needs_verification" | "disabled" | "configuration_changed";
  saved: boolean;
  launchEnabled: false;
  message: string;
  maskedAdvertiserId?: string;
  currency?: string;
  timezone?: string;
  verifiedAt?: string;
};
export class TikTokConnectionError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const unavailable = () => new TikTokConnectionError(503, "connection_storage_unavailable", "Не удалось прочитать подключение TikTok. Проверьте миграцию 047 и доступность базы.");
const conflict = () => new TikTokConnectionError(409, "connection_conflict", "Подключение TikTok требует проверки оператором. Перенос аккаунта между клиниками автоматически не выполняется.");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Server provisioning is separate from workspace admin authorization. A user
 * cannot claim the shared env advertiser merely by owning another workspace. */
export function requireTikTokProvisionedWorkspace(workspaceId: string, env: Env = process.env) {
  const provisioned = env.TIKTOK_WORKSPACE_ID?.trim() || "";
  if (!UUID.test(provisioned)) {
    throw new TikTokConnectionError(503, "workspace_not_provisioned", "TikTok ещё не назначен клинике. Оператору нужно настроить серверный TIKTOK_WORKSPACE_ID.");
  }
  if (!UUID.test(workspaceId) || workspaceId.toLowerCase() !== provisioned.toLowerCase()) {
    throw new TikTokConnectionError(403, "workspace_not_authorized", "TikTok не подключён для этой клиники.");
  }
}

export type TikTokConnectionStore = {
  find(workspaceId: string): Promise<TikTokConnectionRow | null>;
  save(row: Omit<TikTokConnectionRow, "enabled">): Promise<void>;
};
function serverStore(): TikTokConnectionStore {
  const client = getSupabaseServerClient();
  if (!client) throw unavailable();
  return {
    async find(workspaceId) {
      const { data, error } = await client.from("tiktok_ad_account_connections")
        .select("workspace_id, advertiser_id, currency, account_timezone, enabled, verified_at")
        .eq("workspace_id", workspaceId).maybeSingle();
      if (error) throw unavailable();
      if (!data) return null;
      const row = data as Record<string, unknown>;
      if (row.workspace_id !== workspaceId || typeof row.advertiser_id !== "string"
        || !/^\d{5,32}$/.test(row.advertiser_id) || typeof row.enabled !== "boolean"
        || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency)
        || typeof row.account_timezone !== "string" || !row.account_timezone
        || typeof row.verified_at !== "string" || !Number.isFinite(Date.parse(row.verified_at))) throw unavailable();
      return row as TikTokConnectionRow;
    },
    async save(row) {
      // The conflict target includes BOTH identifiers. Separate unique indexes
      // reject reassignment, including two simultaneous first-connect requests.
      const { error } = await client.from("tiktok_ad_account_connections").upsert(
        { ...row, updated_at: row.verified_at }, { onConflict: "workspace_id,advertiser_id" },
      );
      if (error?.code === "23505") throw conflict();
      if (error) throw unavailable();
    },
  };
}

type Options = {
  env?: Env;
  store?: TikTokConnectionStore;
  now?: () => number;
  validate?: (env: Env) => Promise<TikTokAdsConnectionDiagnostic>;
};
export function createTikTokConnectionService(options: Options = {}) {
  const env = () => options.env ?? process.env;
  const now = options.now ?? Date.now;
  const store = () => options.store ?? serverStore();
  function summary(row: TikTokConnectionRow | null): TikTokConnectionSummary {
    if (!row) return { state: "not_connected", saved: false, launchEnabled: false, message: "Аккаунт ещё не привязан к клинике." };
    const config = getTikTokAdsConfig(env());
    const verifiedTime = Date.parse(row.verified_at);
    const fresh = Number.isFinite(verifiedTime) && verifiedTime <= now() && now() - verifiedTime < 86_400_000;
    const state = !row.enabled ? "disabled" : row.advertiser_id !== config.advertiserId ? "configuration_changed"
      : !config.configured || !fresh ? "needs_verification" : "connected";
    const copy = {
      disabled: "Подключение отключено оператором.",
      configuration_changed: "Серверный аккаунт изменён. Привязку должен проверить оператор.",
      needs_verification: "Связь сохранена. Повторите проверку доступа к TikTok.",
      connected: "Аккаунт TikTok закреплён за этой клиникой.",
    };
    return {
      state, saved: true, launchEnabled: false, message: copy[state],
      maskedAdvertiserId: `****${row.advertiser_id.slice(-4)}`,
      currency: row.currency, timezone: row.account_timezone, verifiedAt: row.verified_at,
    };
  }
  async function read(workspaceId: string) {
    requireTikTokProvisionedWorkspace(workspaceId, env());
    try { return summary(await store().find(workspaceId)); } catch (error) {
      if (error instanceof TikTokConnectionError) throw error;
      throw unavailable();
    }
  }
  async function connect(workspaceId: string): Promise<TikTokConnectionSummary> {
    requireTikTokProvisionedWorkspace(workspaceId, env());
    const config = getTikTokAdsConfig(env());
    if (!config.configured) throw new TikTokConnectionError(503, "account_not_configured", "Серверные настройки TikTok не заполнены или имеют неверный формат.");
    try {
      const repository = store();
      const existing = await repository.find(workspaceId);
      if (existing && (!existing.enabled || existing.advertiser_id !== config.advertiserId)) throw conflict();
      const diagnostic = await (options.validate ?? ((settings) => validateTikTokAdsConnection({ env: settings })))(env());
      if (!diagnostic.connected || !diagnostic.advertiser) {
        throw new TikTokConnectionError(502, "account_verification_failed", diagnostic.message || "TikTok не подтвердил доступ к аккаунту.");
      }
      const { currency, timezone } = diagnostic.advertiser;
      if (!/^[A-Z]{3}$/.test(currency) || !timezone || timezone.length > 100) {
        throw new TikTokConnectionError(502, "account_metadata_invalid", "TikTok не подтвердил валюту и часовой пояс аккаунта.");
      }
      const row = { workspace_id: workspaceId, advertiser_id: config.advertiserId, currency,
        account_timezone: timezone, verified_at: new Date(now()).toISOString() };
      await repository.save(row);
      // Read back: an operator may revoke the connection while TikTok responds.
      return summary(await repository.find(workspaceId));
    } catch (error) {
      if (error instanceof TikTokConnectionError) throw error;
      throw unavailable();
    }
  }
  return { read, connect };
}
const service = createTikTokConnectionService();
export const readTikTokConnection = service.read;
export const connectTikTokAccount = service.connect;
