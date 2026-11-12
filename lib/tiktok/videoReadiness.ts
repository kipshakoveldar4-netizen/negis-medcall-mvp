import { URL } from "node:url";
import { TikTokConnectionError } from "./connections";
import { getTikTokAdsConfig } from "./diagnostics";

export const TIKTOK_VIDEO_INFO_ENDPOINT = "/open_api/v1.3/file/video/ad/info/";

export type TikTokVideoReadinessResult = {
  state: "processing" | "ready" | "not_displayable";
  displayable: boolean | null;
  tiktokPlacementAllowed: boolean | null;
};

type TikTokVideoInfoResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

export type TikTokVideoInfoFetch = (
  input: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    redirect: "error";
    signal: unknown;
  },
) => Promise<TikTokVideoInfoResponse>;

type Options = {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: TikTokVideoInfoFetch;
  timeoutMs?: number;
};

export class TikTokVideoReadinessError extends TikTokConnectionError {
  constructor(
    code: "provider_rejected" | "check_unknown",
    message: string,
    public readonly uncertain: boolean,
  ) {
    super(502, code, message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
  return null;
}

function unknownResult(message = "Не удалось подтвердить готовность видео в TikTok. Повторная загрузка не выполнялась.") {
  return new TikTokVideoReadinessError("check_unknown", message, true);
}

function rejectedResult() {
  return new TikTokVideoReadinessError(
    "provider_rejected",
    "TikTok отклонил проверку видео. Проверьте права рекламного аккаунта и повторите позже.",
    false,
  );
}

/** Read-only provider check. Temporary preview/cover URLs from TikTok are
 * deliberately ignored and never leave this module. */
export async function checkTikTokVideoReadiness(
  videoId: string,
  options: Options = {},
): Promise<TikTokVideoReadinessResult> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(videoId)) throw unknownResult();

  const env = options.env ?? process.env;
  const config = getTikTokAdsConfig(env);
  if (!config.configured) throw rejectedResult();

  const runtimeFetch = (globalThis as unknown as { fetch?: TikTokVideoInfoFetch }).fetch;
  const safeFetch = options.fetchImpl ?? runtimeFetch;
  if (typeof safeFetch !== "function") throw unknownResult();

  const url = new URL(TIKTOK_VIDEO_INFO_ENDPOINT, "https://business-api.tiktok.com");
  url.searchParams.set("advertiser_id", config.advertiserId);
  url.searchParams.set("video_ids", JSON.stringify([videoId]));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(15_000, Math.max(1_000, options.timeoutMs ?? 8_000)));
  let response: TikTokVideoInfoResponse;
  let rawText: string;
  try {
    response = await safeFetch(url.toString(), {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json", "Access-Token": config.accessToken },
    });
    rawText = await response.text();
  } catch {
    throw unknownResult();
  } finally {
    clearTimeout(timer);
  }

  if ([401, 403, 429].includes(response.status)) throw rejectedResult();
  if (!response.ok || !rawText.trim()) throw unknownResult();

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawText);
    payload = isRecord(parsed) ? parsed : {};
  } catch {
    throw unknownResult();
  }

  const code = readCode(payload.code);
  if (code === null) throw unknownResult();
  if (code !== 0) throw rejectedResult();

  const data = isRecord(payload.data) ? payload.data : {};
  const items = Array.isArray(data.list) ? data.list.filter(isRecord) : [];
  const item = items.find((candidate) => candidate.video_id === videoId);

  // TikTok may not return a freshly uploaded or currently unusable video yet.
  // Treat omission as processing rather than inventing a permanent rejection.
  if (!item) return { state: "processing", displayable: null, tiktokPlacementAllowed: null };
  if (typeof item.displayable !== "boolean") throw unknownResult();

  const placements = Array.isArray(item.allowed_placements)
    ? item.allowed_placements.filter((value): value is string => typeof value === "string")
    : null;
  const tiktokPlacementAllowed = placements ? placements.includes("PLACEMENT_TIKTOK") : null;

  if (!item.displayable || tiktokPlacementAllowed === false) {
    return { state: "not_displayable", displayable: item.displayable, tiktokPlacementAllowed };
  }
  if (tiktokPlacementAllowed === true) {
    return { state: "ready", displayable: true, tiktokPlacementAllowed: true };
  }
  return { state: "processing", displayable: true, tiktokPlacementAllowed: null };
}
