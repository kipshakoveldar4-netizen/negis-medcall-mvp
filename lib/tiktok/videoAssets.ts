import { randomUUID } from "node:crypto";
import { getSupabaseServerClient } from "../supabase/server";
import { readTikTokConnection, requireTikTokProvisionedWorkspace, TikTokConnectionError } from "./connections";
import { getTikTokAdsConfig, validateTikTokAdsConnection } from "./diagnostics";
import { checkTikTokVideoReadiness, TikTokVideoReadinessError,
  type TikTokVideoReadinessResult } from "./videoReadiness";
import { prepareTikTokVideo, uploadTikTokVideo, videoAssetIssue, TikTokVideoError,
  type PreparedTikTokVideo, type TikTokVideoAsset, type TikTokVideoEnv } from "./videoUpload";

type UploadStatus = "uploading" | "uploaded" | "failed" | "unknown";
export type TikTokVideoReadinessStatus = "not_checked" | "processing" | "ready" | "not_displayable" | "unknown";
export type TikTokVideoReceipt = {
  id: string; workspace_id: string; advertiser_id: string; asset_id: string; source_fingerprint: string;
  asset_revision: string; status: UploadStatus; video_id: string | null; error_code: string | null;
  attempt: number; started_at: string; finished_at: string | null; readiness_status: TikTokVideoReadinessStatus;
  displayable: boolean | null; tiktok_placement_allowed: boolean | null; readiness_checked_at: string | null;
  readiness_error_code: "provider_rejected" | "check_unknown" | "connection_revoked" | null;
};
export type TikTokVideoSummary = {
  assetId: string; status: UploadStatus | "not_uploaded"; readinessStatus: TikTokVideoReadinessStatus;
  message: string; canRetry: boolean; videoIdAvailable: boolean; readyForAd: boolean; checkedAt: string | null;
};
export type TikTokReadyVideoForLaunch = {
  receiptId: string;
  videoId: string;
};
export type TikTokVideoList = { enabled: boolean; launchEnabled: false; assets: { id: string; fileName: string; issue: string | null }[] };
export type TikTokVideoStore = {
  assets(workspaceId: string): Promise<TikTokVideoAsset[]>;
  asset(workspaceId: string, assetId: string): Promise<TikTokVideoAsset | null>;
  latest(workspaceId: string, advertiserId: string, assetId: string): Promise<TikTokVideoReceipt | null>;
  claim(row: TikTokVideoReceipt, retry: boolean): Promise<{ claimed: boolean; row: TikTokVideoReceipt }>;
  finish(row: TikTokVideoReceipt): Promise<void>;
  saveReadiness(row: TikTokVideoReceipt): Promise<TikTokVideoReceipt>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storageError = () => new TikTokVideoError("persistence_failed", "Не удалось проверить журнал TikTok-видео. Проверьте миграции 048–049 и доступ к базе.", false, 503);
const assetFields = "id,workspace_id,file_name,file_type,mime_type,file_size,storage_bucket,storage_path,status,updated_at";
const receiptFields = "id,workspace_id,advertiser_id,asset_id,source_fingerprint,asset_revision,status,video_id,error_code,attempt,started_at,finished_at,readiness_status,displayable,tiktok_placement_allowed,readiness_checked_at,readiness_error_code";

function serverStore(): TikTokVideoStore {
  const client = getSupabaseServerClient();
  if (!client) throw storageError();
  return {
    async assets(workspaceId) {
      const { data, error } = await client.from("ad_creative_assets").select(assetFields).eq("workspace_id", workspaceId)
        .eq("file_type", "video").order("created_at", { ascending: false }).limit(40);
      if (error) throw storageError();
      return (data ?? []) as TikTokVideoAsset[];
    },
    async asset(workspaceId, assetId) {
      const { data, error } = await client.from("ad_creative_assets").select(assetFields).eq("workspace_id", workspaceId).eq("id", assetId).maybeSingle();
      if (error) throw storageError();
      return data as TikTokVideoAsset | null;
    },
    async latest(workspaceId, advertiserId, assetId) {
      const { data, error } = await client.from("tiktok_video_uploads").select(receiptFields).eq("workspace_id", workspaceId)
        .eq("advertiser_id", advertiserId).eq("asset_id", assetId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw storageError();
      return data as TikTokVideoReceipt | null;
    },
    async claim(row, retry) {
      const { error } = await client.from("tiktok_video_uploads").insert(row);
      if (!error) return { claimed: true, row };
      if (error.code !== "23505") throw storageError();
      const { data: existing, error: readError } = await client.from("tiktok_video_uploads").select(receiptFields)
        .eq("workspace_id", row.workspace_id).eq("advertiser_id", row.advertiser_id).eq("asset_id", row.asset_id)
        .eq("source_fingerprint", row.source_fingerprint).single();
      if (readError || !existing) throw storageError();
      const current = existing as TikTokVideoReceipt;
      if (current.status === "uploaded" && current.asset_revision !== row.asset_revision) {
        // HEAD proved that the content fingerprint is unchanged despite a metadata edit.
        const { error: revisionError } = await client.from("tiktok_video_uploads").update({ asset_revision: row.asset_revision, updated_at: row.started_at })
          .eq("workspace_id", row.workspace_id).eq("id", current.id).eq("status", "uploaded");
        if (revisionError) throw storageError();
        return { claimed: false, row: { ...current, asset_revision: row.asset_revision } };
      }
      if (retry && current.status === "failed" && current.attempt < 3) {
        // Compare-and-swap: two retry clicks cannot both own this upload.
        const { data, error: retryError } = await client.from("tiktok_video_uploads").update({
          status: "uploading", attempt: current.attempt + 1, started_at: row.started_at, finished_at: null,
          error_code: null, asset_revision: row.asset_revision, updated_at: row.started_at,
          readiness_status: "not_checked", displayable: null, tiktok_placement_allowed: null,
          readiness_checked_at: null, readiness_error_code: null,
        }).eq("workspace_id", row.workspace_id).eq("id", current.id).eq("status", "failed")
          .eq("attempt", current.attempt).select(receiptFields).maybeSingle();
        if (retryError) throw storageError();
        if (data) return { claimed: true, row: data as TikTokVideoReceipt };
        return { claimed: false, row: { ...current, status: "uploading", started_at: row.started_at } };
      }
      return { claimed: false, row: current };
    },
    async finish(row) {
      const { data, error } = await client.from("tiktok_video_uploads").update({ status: row.status, video_id: row.video_id,
        error_code: row.error_code, finished_at: row.finished_at, updated_at: row.finished_at })
        .eq("workspace_id", row.workspace_id).eq("id", row.id).eq("status", "uploading").eq("attempt", row.attempt).select("id").maybeSingle();
      if (error || !data) throw storageError();
    },
    async saveReadiness(row) {
      const { data, error } = await client.from("tiktok_video_uploads").update({
        readiness_status: row.readiness_status,
        displayable: row.displayable,
        tiktok_placement_allowed: row.tiktok_placement_allowed,
        readiness_checked_at: row.readiness_checked_at,
        readiness_error_code: row.readiness_error_code,
        updated_at: row.readiness_checked_at,
      }).eq("workspace_id", row.workspace_id).eq("id", row.id).eq("status", "uploaded")
        .eq("asset_revision", row.asset_revision).eq("video_id", row.video_id)
        .select(receiptFields).maybeSingle();
      if (error || !data) throw storageError();
      return data as TikTokVideoReceipt;
    },
  };
}

type Options = {
  env?: TikTokVideoEnv; store?: TikTokVideoStore; now?: () => number;
  connection?: (workspaceId: string) => Promise<{ state: string }>;
  verify?: () => Promise<boolean>;
  prepare?: (asset: TikTokVideoAsset, workspaceId: string) => Promise<PreparedTikTokVideo>;
  upload?: (prepared: PreparedTikTokVideo, receiptId: string) => Promise<string>;
  check?: (videoId: string) => Promise<TikTokVideoReadinessResult>;
};
export function createTikTokVideoService(options: Options = {}) {
  const env = () => options.env ?? process.env;
  const now = options.now ?? Date.now;
  const store = () => options.store ?? serverStore();
  const enabled = () => env().TIKTOK_VIDEO_UPLOAD_ENABLED === "true";
  async function authorize(workspaceId: string) {
    requireTikTokProvisionedWorkspace(workspaceId, env());
    if ((await (options.connection ?? readTikTokConnection)(workspaceId)).state !== "connected") {
      throw new TikTokConnectionError(409, "connection_required", "Сначала подключите и проверьте аккаунт TikTok для этой клиники.");
    }
  }
  async function getAsset(workspaceId: string, assetId: string, repository: TikTokVideoStore) {
    if (!UUID.test(assetId)) throw new TikTokVideoError("invalid_asset", "Выберите видео из библиотеки клиники.", false, 400);
    const asset = await repository.asset(workspaceId, assetId);
    if (!asset || asset.workspace_id !== workspaceId) throw new TikTokVideoError("asset_not_found", "Видео не найдено в этой клинике.", false, 404);
    return asset;
  }
  function summary(asset: TikTokVideoAsset, receipt: TikTokVideoReceipt | null): TikTokVideoSummary {
    const matches = receipt && (receipt.asset_revision === asset.updated_at || receipt.status !== "uploaded");
    const status = !matches ? "not_uploaded" : receipt.status === "uploading" && now() - Date.parse(receipt.started_at) > 120_000 ? "unknown" : receipt.status;
    const readinessStatus = status === "uploaded" ? receipt?.readiness_status ?? "not_checked" : "not_checked";
    const uploadCopy = {
      not_uploaded: "Видео ещё не передано в TikTok.",
      uploading: "Видео передаётся. Обновите статус через минуту; повторная передача заблокирована.",
      failed: "TikTok отклонил передачу. Проверьте формат и доступ к аккаунту перед повторной попыткой.",
      unknown: "Результат передачи неизвестен. Не отправляем повторно: проверьте библиотеку TikTok Ads.",
    };
    const readinessCopy: Record<TikTokVideoReadinessStatus, string> = {
      not_checked: "Видео передано в TikTok. Проверьте, завершилась ли обработка ролика.",
      processing: "TikTok ещё обрабатывает видео. Проверьте готовность позже.",
      ready: "Видео готово для объявления в TikTok.",
      not_displayable: "TikTok не разрешил использовать это видео в рекламе. Проверьте ролик в библиотеке TikTok Ads.",
      unknown: "Не удалось подтвердить готовность видео. Повторная загрузка не выполнялась.",
    };
    return { assetId: asset.id, status, readinessStatus,
      message: status === "uploaded" ? readinessCopy[readinessStatus] : uploadCopy[status],
      canRetry: status === "failed" && (receipt?.attempt ?? 3) < 3,
      videoIdAvailable: status === "uploaded" && Boolean(receipt?.video_id) && !videoAssetIssue(asset, asset.workspace_id),
      readyForAd: status === "uploaded" && readinessStatus === "ready",
      checkedAt: status === "uploaded" ? receipt?.readiness_checked_at ?? null : null };
  }
  async function list(workspaceId: string): Promise<TikTokVideoList> {
    await authorize(workspaceId);
    return { enabled: enabled(), launchEnabled: false, assets: (await store().assets(workspaceId)).map((asset) => ({
      id: asset.id, fileName: asset.file_name, issue: videoAssetIssue(asset, workspaceId),
    })) };
  }
  async function read(workspaceId: string, assetId: string) {
    await authorize(workspaceId);
    const repository = store();
    const asset = await getAsset(workspaceId, assetId, repository);
    const row = await repository.latest(workspaceId, getTikTokAdsConfig(env()).advertiserId, assetId);
    return summary(asset, row);
  }
  async function transfer(workspaceId: string, assetId: string, retry = false) {
    await authorize(workspaceId);
    if (!enabled()) throw new TikTokVideoError("upload_disabled", "Передача видео в TikTok пока отключена оператором.");
    const repository = store();
    const asset = await getAsset(workspaceId, assetId, repository);
    const issue = videoAssetIssue(asset, workspaceId);
    if (issue) throw new TikTokVideoError("video_not_ready", issue);
    // Each user-confirmed write rechecks provider access, even inside the 24h connection window.
    if (!await (options.verify ?? (async () => (await validateTikTokAdsConnection({ env: env() })).connected))()) {
      throw new TikTokVideoError("connection_revoked", "TikTok не подтвердил доступ. Повторите проверку подключения.", false, 502);
    }
    const prepared = await (options.prepare ?? ((video, workspace) => prepareTikTokVideo(video, workspace, { env: env() })))(asset, workspaceId);
    const claim = await repository.claim({ id: randomUUID(), workspace_id: workspaceId, advertiser_id: getTikTokAdsConfig(env()).advertiserId,
      asset_id: assetId, source_fingerprint: prepared.fingerprint, asset_revision: asset.updated_at, status: "uploading",
      video_id: null, error_code: null, attempt: 1, started_at: new Date(now()).toISOString(), finished_at: null,
      readiness_status: "not_checked", displayable: null, tiktok_placement_allowed: null,
      readiness_checked_at: null, readiness_error_code: null }, retry);
    if (!claim.claimed) return summary(asset, claim.row);
    let final = claim.row;
    let providerStarted = false;
    try {
      // An operator may disable the connection while HEAD/provider checks run.
      await authorize(workspaceId);
      providerStarted = true;
      const videoId = await (options.upload ?? ((video, id) => uploadTikTokVideo(video, id, { env: env() })))(prepared, claim.row.id);
      final = { ...claim.row, status: "uploaded", video_id: videoId, finished_at: new Date(now()).toISOString() };
    } catch (error) {
      const providerRejected = error instanceof TikTokVideoError && !error.uncertain;
      const known = !providerStarted || providerRejected;
      final = { ...claim.row, status: known ? "failed" : "unknown",
        error_code: !providerStarted ? "connection_revoked" : providerRejected ? "provider_rejected" : "upload_unknown",
        finished_at: new Date(now()).toISOString() };
    }
    try { await repository.finish(final); } catch {
      // The durable uploading claim remains: a lost persistence response must
      // never turn into a second provider upload on the next click.
      return summary(asset, { ...claim.row, status: "unknown" });
    }
    return summary(asset, final);
  }
  async function checkReadiness(workspaceId: string, assetId: string) {
    await authorize(workspaceId);
    const repository = store();
    const asset = await getAsset(workspaceId, assetId, repository);
    const receipt = await repository.latest(workspaceId, getTikTokAdsConfig(env()).advertiserId, assetId);
    if (!receipt || receipt.status !== "uploaded" || !receipt.video_id || receipt.asset_revision !== asset.updated_at
      || videoAssetIssue(asset, workspaceId)) {
      throw new TikTokVideoError("video_not_uploaded", "Сначала передайте актуальную версию видео в TikTok.", false, 409);
    }

    const checkedAt = new Date(now()).toISOString();
    let final: TikTokVideoReceipt;
    try {
      // A readiness result is trusted only after fresh provider access succeeds.
      if (!await (options.verify ?? (async () => (await validateTikTokAdsConnection({ env: env() })).connected))()) {
        final = { ...receipt, readiness_status: "unknown", displayable: null, tiktok_placement_allowed: null,
          readiness_checked_at: checkedAt, readiness_error_code: "connection_revoked" };
      } else {
        await authorize(workspaceId);
        const result = await (options.check ?? ((id) => checkTikTokVideoReadiness(id, { env: env() })))(receipt.video_id);
        final = { ...receipt, readiness_status: result.state, displayable: result.displayable,
          tiktok_placement_allowed: result.tiktokPlacementAllowed, readiness_checked_at: checkedAt, readiness_error_code: null };
      }
    } catch (error) {
      final = { ...receipt, readiness_status: "unknown", displayable: null, tiktok_placement_allowed: null,
        readiness_checked_at: checkedAt,
        readiness_error_code: error instanceof TikTokVideoReadinessError && !error.uncertain ? "provider_rejected" : "check_unknown" };
    }
    return summary(asset, await repository.saveReadiness(final));
  }
  /**
   * Server-only resolver for the live adapter. The public video endpoints keep
   * returning booleans; the provider video_id leaves this module only for the
   * next server-side TikTok request.
   */
  async function resolveReadyForLaunch(
    workspaceId: string,
    assetId: string,
  ): Promise<TikTokReadyVideoForLaunch> {
    await authorize(workspaceId);
    const repository = store();
    const asset = await getAsset(workspaceId, assetId, repository);
    const receipt = await repository.latest(
      workspaceId,
      getTikTokAdsConfig(env()).advertiserId,
      assetId,
    );
    if (
      !receipt ||
      receipt.status !== "uploaded" ||
      !receipt.video_id ||
      receipt.asset_revision !== asset.updated_at ||
      receipt.readiness_status !== "ready" ||
      receipt.displayable !== true ||
      receipt.tiktok_placement_allowed !== true ||
      videoAssetIssue(asset, workspaceId)
    ) {
      throw new TikTokVideoError(
        "video_not_ready",
        "Дождитесь обработки видео и подтвердите его готовность в TikTok.",
        false,
        409,
      );
    }
    return { receiptId: receipt.id, videoId: receipt.video_id };
  }

  return { list, read, transfer, checkReadiness, resolveReadyForLaunch };
}
export const tikTokVideos = createTikTokVideoService();
