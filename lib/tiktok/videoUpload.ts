import { createHash } from "node:crypto";
import { URL } from "node:url";
import { TikTokConnectionError } from "./connections";
import { getTikTokAdsConfig } from "./diagnostics";

export const TIKTOK_VIDEO_MAX_BYTES = 10 * 1024 * 1024;
export type TikTokVideoEnv = Readonly<Record<string, string | undefined>>;
export type TikTokVideoAsset = {
  id: string; workspace_id: string; file_name: string; file_type: string; mime_type: string;
  file_size: number | string; storage_bucket: string; storage_path: string; status: string; updated_at: string;
};
export type TikTokVideoFetch = (url: string, init: {
  method: string; headers?: Record<string, string>; body?: string; redirect: "error"; signal: unknown;
}) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
export type PreparedTikTokVideo = { url: string; fingerprint: string; extension: "mp4" | "mov" };
export class TikTokVideoError extends TikTokConnectionError {
  constructor(code: string, message: string, public readonly uncertain = false, status = 409) { super(status, code, message); }
}
const invalidAsset = () => new TikTokVideoError("video_not_ready", "Выберите готовое видео MP4 или MOV до 10 МБ из файлов этой клиники.");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function videoAssetIssue(asset: TikTokVideoAsset, workspaceId: string): string | null {
  if (asset.workspace_id !== workspaceId || asset.file_type !== "video" || !["ready", "uploaded"].includes(asset.status)) return "Видео ещё не подготовлено.";
  if (!["video/mp4", "video/quicktime"].includes(asset.mime_type)) return "Для передачи нужен MP4 или MOV.";
  if (!Number.isSafeInteger(Number(asset.file_size)) || Number(asset.file_size) <= 0 || Number(asset.file_size) > TIKTOK_VIDEO_MAX_BYTES) return "Для этого этапа нужен ролик до 10 МБ. Подготовьте уменьшенную версию.";
  const parts = asset.storage_path.split("/");
  if (asset.storage_bucket !== "ad-creatives" || !asset.updated_at || !Number.isFinite(Date.parse(asset.updated_at))
    || !/^[0-9a-f-]{36}$/i.test(workspaceId)
    || !(parts[0] === workspaceId || (parts[0] === "optimized" && parts[1] === workspaceId))
    || parts.some((part) => !part || part === "." || part === ".." || /[%\\?#\u0000-\u001f]/.test(part))) return "Публичный файл клиники ещё не подготовлен.";
  return null;
}

/** Only server-configured Supabase storage and workspace-owned paths are accepted.
 * Browser public_url/file_size are not proof: verify the actual object with HEAD. */
export async function prepareTikTokVideo(asset: TikTokVideoAsset, workspaceId: string, options: {
  env?: TikTokVideoEnv; fetchImpl?: TikTokVideoFetch; timeoutMs?: number;
} = {}): Promise<PreparedTikTokVideo> {
  if (videoAssetIssue(asset, workspaceId)) throw invalidAsset();
  let origin: URL;
  try { origin = new URL((options.env ?? process.env).SUPABASE_URL || ""); } catch { throw invalidAsset(); }
  if (origin.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(origin.hostname) || origin.port || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) throw invalidAsset();
  const url = `${origin.origin}/storage/v1/object/public/ad-creatives/${asset.storage_path.split("/").map(encodeURIComponent).join("/")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await (options.fetchImpl ?? fetch as unknown as TikTokVideoFetch)(url, { method: "HEAD", redirect: "error", signal: controller.signal });
    const length = response.headers.get("content-length") || "";
    const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const etag = response.headers.get("etag") || "";
    if (!response.ok || !/^\d+$/.test(length) || BigInt(length) <= 0n || BigInt(length) > BigInt(TIKTOK_VIDEO_MAX_BYTES)
      || mime !== asset.mime_type || !etag || etag.length > 200 || etag.startsWith("W/")) throw invalidAsset();
    return { url, extension: mime === "video/quicktime" ? "mov" : "mp4",
      fingerprint: createHash("sha256").update(JSON.stringify([asset.storage_path, etag, length, mime])).digest("hex") };
  } catch (error) {
    if (error instanceof TikTokVideoError) throw error;
    throw new TikTokVideoError("storage_unavailable", "Не удалось проверить публичный видеофайл. Передача в TikTok не начиналась.", false, 502);
  } finally { clearTimeout(timer); }
}

/** Side effect: uploads an asset, never a campaign. No automatic retries after an
 * ambiguous response: TikTok can issue a new video_id for the same content. */
export async function uploadTikTokVideo(prepared: PreparedTikTokVideo, receiptId: string, options: {
  env?: TikTokVideoEnv; fetchImpl?: TikTokVideoFetch; timeoutMs?: number;
} = {}): Promise<string> {
  const env = options.env ?? process.env;
  const config = getTikTokAdsConfig(env);
  if (env.TIKTOK_VIDEO_UPLOAD_ENABLED !== "true" || !config.configured) throw new TikTokVideoError("upload_disabled", "Передача видео в TikTok пока отключена оператором.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
  try {
    const response = await (options.fetchImpl ?? fetch as unknown as TikTokVideoFetch)("https://business-api.tiktok.com/open_api/v1.3/file/video/ad/upload/", {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "Access-Token": config.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ advertiser_id: config.advertiserId, upload_type: "UPLOAD_BY_URL",
        video_url: prepared.url, file_name: `negis-${receiptId}.${prepared.extension}`,
        flaw_detect: false, auto_fix_enabled: false, auto_bind_enabled: false, pre_review_enabled: false }),
    });
    if ([401, 403, 429].includes(response.status)) throw new TikTokVideoError("provider_rejected", "TikTok отклонил передачу. Проверьте права аккаунта и лимиты запросов.", false, 502);
    if (!response.ok) throw new TikTokVideoError("upload_unknown", "TikTok не подтвердил результат передачи. Повторная отправка заблокирована до проверки библиотеки TikTok.", true, 502);
    const raw = await response.text();
    let payload: Record<string, unknown>;
    try { payload = record(JSON.parse(raw)); } catch { throw new Error("invalid_body"); }
    if (typeof payload.code !== "number") throw new Error("invalid_code");
    if (payload.code !== 0) throw new TikTokVideoError("provider_rejected", "TikTok отклонил видео. Проверьте формат файла, доступ к аккаунту и лимиты запросов.", false, 502);
    // TikTok documentation revisions have exposed `data` both as the single
    // object and as a one-item collection. Accept only those two unambiguous
    // shapes; everything else remains unknown to avoid a blind second upload.
    const item = Array.isArray(payload.data) && payload.data.length === 1
      ? record(payload.data[0]) : record(payload.data);
    if (typeof item.video_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.video_id) || item.fix_task_id) throw new Error("missing_video_id");
    return item.video_id;
  } catch (error) {
    if (error instanceof TikTokVideoError) throw error;
    throw new TikTokVideoError("upload_unknown", "Результат передачи неизвестен. Не отправляем повторно: проверьте библиотеку TikTok Ads.", true, 502);
  } finally { clearTimeout(timer); }
}
