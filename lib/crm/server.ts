import type { VercelRequest, VercelResponse } from "@vercel/node";
import { canAssignRole, isStaffRole } from "../auth/permissions";
import { normalizePhone } from "./phone";
import {
  listAuthContextMemberships,
  requireWorkspaceAdmin,
  WorkspaceAdminAuthError,
  type WorkspaceAccessContext,
} from "../auth/server";
import {
  META_INSIGHTS_BACKGROUND_CYCLE_PATH,
  WORKER_REQUEST_ID_HEADER,
  WorkerAuthError,
  getWorkerAuthConfig,
  resolveSignedRawBody,
  verifyWorkerRequest,
  type VerifiedWorkerRequest,
  type WorkerAuthConfig,
} from "../auth/worker";
import {
  buildMetaLaunchPayloadPreview,
  type MetaLaunchPayloadOptions,
} from "./meta-launch-payload";
import { evaluateMetaInsightsCompleteness } from "../meta/insightsCompleteness";
import { getSupabaseServerClient } from "../supabase/server";
import {
  diffForJournal,
  journaledEntityFor,
  readRowBeforeChange,
  recordCrmChange,
} from "./change-journal";
import { checkMetaCompliance } from "../meta/compliance";
import {
  MetaApiError,
  type MetaTargetingResolution,
  buildMetaTargetingDebug,
  buildMetaAdSetPayload,
  buildMetaCampaignPayload,
  checkMetaAdAccount,
  checkMetaInstagramActor,
  formatKazakhstanTimestamp,
  getMetaCampaignStatus,
  getMetaConfig,
  isMetaVideoLaunchEnabled,
  launchMetaCampaign,
  checkMetaVideoProcessingStatus,
  META_VIDEO_LAUNCH_DISABLED_MESSAGE,
  META_VIDEO_FORMAT_ERROR,
  META_MOV_VIDEO_WARNING,
  META_VIDEO_PROCESSING_TIMEOUT_MESSAGE,
  META_VIDEO_THUMBNAIL_REQUIRED_MESSAGE,
  resolveVideoThumbnailUrl,
  resolveMetaCityTarget,
  resolveMetaTargetingForCity,
  isSupportedMetaVideoFormat,
  uploadMetaVideoAndGetId,
} from "../meta/marketing";
import { KZ_META_CITY_OPTIONS, findKzMetaCityOption, getKzMetaCityOption, type MetaCitySearchCandidate } from "../meta/cities";
import {
  META_INSIGHTS_SAFE_ERROR_CODES,
  MetaInsightsError,
  fetchCampaignInsightsDaily,
  type MetaInsightsSafeErrorCode,
  type NormalizedMetaInsightRow,
} from "../meta/insights";

export type CrmResource =
  | "clients"
  | "leads"
  | "lead-stages"
  | "lead-sources"
  | "deals"
  | "appointments"
  | "calls"
  | "tasks"
  | "chat"
  | "staff"
  | "content-videos"
  | "admin-settings"
  | "integration-statuses"
  | "ai-providers"
  | "meta-accounts"
  | "meta-launches"
  | "ad-creatives"
  | "release-checks";

type CrmMode = "supabase" | "demo";
type JsonRecord = Record<string, unknown>;
type QueryValue = string | string[] | undefined;

type CrmFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type CrmFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<CrmFetchResponse>;

type SupabaseAdminCreateUserResult = {
  data?: {
    user?: {
      id?: string | null;
    } | null;
  } | null;
  error?: {
    message?: string;
  } | null;
};

type SupabaseAdminCapableClient = {
  auth?: {
    admin?: {
      createUser(input: {
        email: string;
        password: string;
        email_confirm: boolean;
        user_metadata: Record<string, unknown>;
      }): Promise<SupabaseAdminCreateUserResult>;
    };
  };
};

type ResourceConfig = {
  table: string;
  listKey: string;
  requiredPost: string[];
  requiredPatch?: string[];
  sortableColumn: string;
  sortableAscending?: boolean;
  selectColumns?: string;
  upsertConflict?: string;
  toRow: (body: JsonRecord, workspaceId: string) => JsonRecord;
  fromRow: (row: JsonRecord) => JsonRecord;
  demoItem: (body: JsonRecord) => JsonRecord;
};

type MultipartFile = {
  fieldName: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
};

type MultipartFormData = {
  fields: JsonRecord;
  file?: MultipartFile;
};

const DEMO_WORKSPACE_ID = "demo-workspace";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class CrmReferenceValidationError extends Error {
  readonly details: string[];

  constructor(details: string[]) {
    super("Validation error");
    this.name = "CrmReferenceValidationError";
    this.details = details;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asRelatedRecord(value: unknown): JsonRecord {
  return asRecord(Array.isArray(value) ? value[0] : value);
}

function readJsonRecord(value: unknown): JsonRecord {
  if (typeof value === "string" && value.trim()) {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }

  return asRecord(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readQueryString(value: QueryValue): string {
  return readString(Array.isArray(value) ? value[0] : value);
}

function readNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function readJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = readString(value);
    if (text) return text;
  }

  return "";
}

function buildSupabaseStoragePublicUrl(input: { bucket?: string; storagePath?: string }): string {
  const supabaseUrl = firstString(process.env.SUPABASE_URL, process.env.VITE_SUPABASE_URL).replace(/\/$/, "");
  const bucket = firstString(input.bucket, "ad-creatives");
  const storagePath = firstString(input.storagePath);
  if (!supabaseUrl || !bucket || !storagePath) return "";

  const encodedPath = storagePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodedPath}`;
}

function resolveAdCreativePublicUrl(body: JsonRecord): string {
  const directUrl = firstString(
    body.publicUrl,
    body.public_url,
    body.publicURL,
    body.url,
    body.imageUrl,
    body.image_url,
    body.imageURL,
    body.videoUrl,
    body.video_url,
    body.videoURL,
    body.creativeUrl,
    body.creative_url,
  );
  if (directUrl) return directUrl;

  return buildSupabaseStoragePublicUrl({
    bucket: firstString(body.storageBucket, body.storage_bucket, "ad-creatives"),
    storagePath: firstString(body.storagePath, body.storage_path),
  });
}

function hasAnyKey(body: JsonRecord, keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

function maybeDate(value: unknown): string | null {
  const text = readString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Security-2B: columns the browser may never set on an update. workspace_id is
// the tenant itself, id and created_at identify the row, and auth_user_id is the
// link to a Supabase Auth identity — accepting it would let a caller bind
// someone else's login to a privileged staff row.
const SERVER_OWNED_COLUMNS = new Set([
  "id",
  "workspace_id",
  "workspaceId",
  "auth_user_id",
  "authUserId",
  "created_at",
  "createdAt",
]);

function stripServerOwnedColumns(row: JsonRecord): JsonRecord {
  for (const column of Object.keys(row)) {
    if (SERVER_OWNED_COLUMNS.has(column)) delete row[column];
  }
  return row;
}

function buildPatchRow(resource: CrmResource, body: JsonRecord): JsonRecord {
  const row: JsonRecord = {};

  const setText = (column: string, keys: string[]) => {
    if (hasAnyKey(body, keys)) {
      row[column] = firstString(...keys.map((key) => body[key])) || null;
    }
  };

  const setRaw = (column: string, keys: string[]) => {
    if (hasAnyKey(body, keys)) {
      row[column] = keys.map((key) => body[key]).find((value) => value !== undefined) ?? null;
    }
  };

  const setDate = (column: string, keys: string[]) => {
    if (hasAnyKey(body, keys)) {
      row[column] = maybeDate(keys.map((key) => body[key]).find((value) => value !== undefined)) ?? null;
    }
  };

  const setNumber = (column: string, keys: string[]) => {
    if (hasAnyKey(body, keys)) {
      row[column] = readNumber(keys.map((key) => body[key]).find((value) => value !== undefined));
    }
  };

  const setBoolean = (column: string, keys: string[]) => {
    if (hasAnyKey(body, keys)) {
      row[column] = readBoolean(keys.map((key) => body[key]).find((value) => value !== undefined));
    }
  };

  if (resource === "clients") {
    setText("full_name", ["name", "full_name", "fullName"]);
    setText("phone", ["phone"]);
    setText("whatsapp", ["whatsapp"]);
    setText("source", ["source"]);
    setText("status", ["status"]);
    setText("notes", ["comment", "notes"]);
    setDate("last_visit_at", ["lastVisit", "last_visit_at"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "leads") {
    setText("full_name", ["name", "full_name", "fullName"]);
    setText("phone", ["phone"]);
    setText("source", ["source"]);
    setText("campaign", ["campaign"]);
    setText("status", ["status"]);
    // notes holds real notes only (no owner overload).
    setText("notes", ["notes"]);
    // client_id moved to buildLeadReferenceRow. It used to be written here with
    // only a uuid-shape check, which is not a tenancy check: the FK points at
    // clients(id) with no workspace clause, so a uuid from another clinic's
    // client would have been accepted and stored. Every other reference on the
    // lead already went through readWorkspaceReference for exactly that reason.
    row.updated_at = new Date().toISOString();
  }

  if (resource === "lead-stages") {
    setText("stage_key", ["stageKey", "stage_key"]);
    setText("name", ["name"]);
    setText("color", ["color"]);
    setText("semantic_group", ["semanticGroup", "semantic_group"]);
    setNumber("sort_order", ["sortOrder", "sort_order"]);
    setBoolean("is_default", ["isDefault", "is_default"]);
    setBoolean("is_active", ["isActive", "is_active"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "lead-sources") {
    setText("source_key", ["sourceKey", "source_key"]);
    setText("name", ["name"]);
    setText("channel", ["channel"]);
    setText("color", ["color"]);
    setNumber("sort_order", ["sortOrder", "sort_order"]);
    setBoolean("is_default", ["isDefault", "is_default"]);
    setBoolean("is_active", ["isActive", "is_active"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "deals") {
    setText("title", ["title"]);
    if (hasAnyKey(body, ["amountMinor", "amount_minor"])) {
      row.amount_minor = readDealAmountMinor(body);
    }
    if (hasAnyKey(body, ["currency"])) {
      row.currency = readString(body.currency).toUpperCase() || "KZT";
    }
    setText("payment_method", ["paymentMethod", "payment_method"]);
    setText("notes", ["notes"]);
    setDate("paid_at", ["paidAt", "paid_at"]);
    setDate("closed_at", ["closedAt", "closed_at"]);
    if (hasAnyKey(body, ["status"])) {
      const status = readString(body.status).toLowerCase();
      if (DEAL_STATUSES.has(status)) {
        row.status = status;
        // paid stamps paid_at; terminal statuses stamp closed_at. Explicit values
        // win; setting pending never auto-clears historical timestamps.
        if (status === "paid" && !hasAnyKey(body, ["paidAt", "paid_at"])) {
          row.paid_at = new Date().toISOString();
        }
        if (status !== "pending" && !hasAnyKey(body, ["closedAt", "closed_at"])) {
          row.closed_at = new Date().toISOString();
        }
      }
    }
    row.updated_at = new Date().toISOString();
  }

  if (resource === "appointments") {
    setText("client_name", ["client", "client_name", "clientName"]);
    setText("client_phone", ["phone", "client_phone", "clientPhone"]);
    setText("whatsapp", ["whatsapp"]);
    setText("service", ["service"]);
    setText("doctor_name", ["doctor", "doctor_name", "doctorName"]);
    setDate("starts_at", ["starts_at", "startsAt"]);
    setRaw("duration_minutes", ["duration_minutes", "durationMinutes"]);
    setText("status", ["status"]);
    setText("notes", ["notes", "time"]);
    setText("source", ["source"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "calls") {
    setText("phone", ["phone"]);
    setText("direction", ["type", "direction"]);
    setText("source", ["source"]);
    setText("result", ["result"]);
    setText("summary", ["summary"]);
    setDate("call_time", ["call_time", "callTime"]);
  }

  if (resource === "tasks") {
    setText("title", ["title"]);
    setText("description", ["description"]);
    setText("assignee_name", ["owner", "assignee_name", "assigneeName"]);
    if (hasAnyKey(body, ["priority"])) {
      const priority = canonicalTaskPriority(body.priority);
      if (!priority) throw new CrmReferenceValidationError(["priority must be one of: low, medium, high"]);
      row.priority = priority;
    }
    if (hasAnyKey(body, ["status"])) {
      const status = canonicalTaskStatus(body.status);
      if (!status) throw new CrmReferenceValidationError(["status must be one of: new, in_progress, done"]);
      row.status = status;
    }
    setDate("due_at", ["deadline", "due_at", "dueAt"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "chat") {
    setText("channel", ["dialog", "channel"]);
    setText("sender_name", ["author", "sender_name", "senderName"]);
    setText("sender_role", ["role", "sender_role", "senderRole"]);
    setText("message", ["text", "message"]);
  }

  if (resource === "staff") {
    setText("full_name", ["name", "full_name", "fullName"]);
    setText("email", ["email"]);
    setText("phone", ["phone"]);
    setText("role", ["role"]);
    setText("status", ["status"]);
    setText("auth_user_id", ["authUserId", "auth_user_id"]);
    setRaw("temporary_password_set", ["temporaryPasswordSet", "temporary_password_set"]);
    setDate("invited_at", ["invitedAt", "invited_at"]);
    setDate("last_login_at", ["lastLoginAt", "last_login_at"]);
    setRaw("password_reset_required", ["passwordResetRequired", "password_reset_required"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "content-videos") {
    setText("title", ["title"]);
    setText("niche", ["niche"]);
    setText("goal", ["goal"]);
    setText("duration", ["duration"]);
    setText("style", ["style"]);
    setText("audience", ["audience"]);
    setText("hook", ["hook"]);
    setText("script", ["script"]);
    setText("voiceover", ["voiceover"]);
    setText("cta", ["cta"]);
    setText("caption", ["caption"]);
    setRaw("hashtags", ["hashtags"]);
    if (hasAnyKey(body, ["hashtags"])) {
      row.hashtags = readJsonArray(body.hashtags);
    }
    setText("avatar_prompt", ["avatarPrompt", "avatar_prompt"]);
    setText("tapnow_prompt", ["tapnowPrompt", "tapnow_prompt"]);
    setText("status", ["status"]);
    row.raw_payload = body;
    row.updated_at = new Date().toISOString();
  }

  if (resource === "admin-settings") {
    setText("key", ["key"]);
    setRaw("value", ["value", "config", "settings"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "integration-statuses") {
    setText("provider", ["provider"]);
    setText("status", ["status"]);
    setText("masked_identifier", ["maskedIdentifier", "masked_identifier"]);
    setDate("last_checked_at", ["lastCheckedAt", "last_checked_at"]);
    setText("last_error", ["lastError", "last_error"]);
    setRaw("metadata", ["metadata"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "ai-providers") {
    setText("provider", ["provider"]);
    setText("purpose", ["purpose"]);
    setRaw("enabled", ["enabled"]);
    setText("model_name", ["modelName", "model_name"]);
    setRaw("config", ["config"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "meta-accounts") {
    setText("meta_business_id", ["metaBusinessId", "meta_business_id"]);
    setText("ad_account_id", ["adAccountId", "ad_account_id"]);
    setText("page_id", ["pageId", "page_id"]);
    setText("instagram_actor_id", ["instagramActorId", "instagram_actor_id"]);
    setText("account_name", ["accountName", "account_name"]);
    setText("currency", ["currency"]);
    setText("timezone_name", ["timezoneName", "timezone_name"]);
    setText("status", ["status"]);
    setRaw("metadata", ["metadata"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "meta-launches") {
    setText("launched_by", ["launchedBy", "launched_by"]);
    setText("launched_by_role", ["launchedByRole", "launched_by_role"]);
    setText("source_module", ["sourceModule", "source_module"]);
    setText("source_id", ["sourceId", "source_id"]);
    setText("campaign_name", ["campaignName", "campaign_name"]);
    setText("objective", ["objective"]);
    setText("status", ["status"]);
    setText("meta_campaign_id", ["metaCampaignId", "meta_campaign_id"]);
    setText("meta_adset_id", ["metaAdSetId", "meta_adset_id"]);
    setText("meta_creative_id", ["metaCreativeId", "meta_creative_id"]);
    setText("meta_ad_id", ["metaAdId", "meta_ad_id"]);
    setText("meta_status", ["metaStatus", "meta_status"]);
    setRaw("budget_daily_minor", ["budgetDailyMinor", "budget_daily_minor"]);
    setRaw("budget_total_minor", ["budgetTotalMinor", "budget_total_minor"]);
    setText("currency", ["currency"]);
    setDate("start_time", ["startTime", "start_time"]);
    setDate("end_time", ["endTime", "end_time"]);
    setText("page_id", ["pageId", "page_id"]);
    setText("instagram_actor_id", ["instagramActorId", "instagram_actor_id"]);
    setText("ad_account_id", ["adAccountId", "ad_account_id"]);
    setRaw("payload", ["payload"]);
    setRaw("compliance", ["compliance"]);
    setRaw("meta_response", ["metaResponse", "meta_response"]);
    setText("last_error", ["lastError", "last_error"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "ad-creatives") {
    setText("launch_id", ["launchId", "launch_id"]);
    setText("uploaded_by", ["uploadedBy", "uploaded_by"]);
    setText("file_name", ["fileName", "file_name"]);
    setText("file_type", ["fileType", "file_type"]);
    setText("mime_type", ["mimeType", "mime_type"]);
    setRaw("file_size", ["fileSize", "file_size"]);
    setText("storage_bucket", ["storageBucket", "storage_bucket"]);
    setText("storage_path", ["storagePath", "storage_path"]);
    setText("public_url", ["publicUrl", "public_url", "publicURL", "url", "imageUrl", "image_url", "imageURL", "videoUrl", "video_url", "videoURL", "creativeUrl", "creative_url"]);
    setText("meta_asset_id", ["metaAssetId", "meta_asset_id"]);
    setText("meta_video_id", ["metaVideoId", "meta_video_id", "videoId", "video_id"]);
    setText("status", ["status"]);
    setRaw("metadata", ["metadata"]);
    row.updated_at = new Date().toISOString();
  }

  if (resource === "release-checks") {
    setText("check_key", ["checkKey", "check_key"]);
    setText("status", ["status"]);
    setText("notes", ["notes"]);
    setDate("checked_at", ["checkedAt", "checked_at"]);
    row.updated_at = new Date().toISOString();
  }

  return stripServerOwnedColumns(
    Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)),
  );
}

function nextDemoId(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

function success(mode: CrmMode, data: JsonRecord, warning?: string) {
  return {
    success: true,
    mode,
    ...(warning ? { warning } : {}),
    data,
  };
}

function errorBody(error: string, details: string[] = []) {
  return {
    success: false,
    error,
    details,
  };
}

// Security-2B: the tenant comes from the verified workspace context the router
// attached after JWT + membership verification. The browser can still send a
// workspaceId, but it is only a selector consumed by lib/auth/server.ts when the
// context is built; past this point it has no effect at all.
const WORKSPACE_CONTEXT_KEY = "__medinaWorkspaceContext" as const;

type RequestWithWorkspaceContext = VercelRequest & {
  [WORKSPACE_CONTEXT_KEY]?: WorkspaceAccessContext;
};

export function attachWorkspaceContext(req: VercelRequest, context: WorkspaceAccessContext): void {
  (req as RequestWithWorkspaceContext)[WORKSPACE_CONTEXT_KEY] = context;
}

export function readWorkspaceContext(req: VercelRequest): WorkspaceAccessContext | null {
  return (req as RequestWithWorkspaceContext)[WORKSPACE_CONTEXT_KEY] ?? null;
}

function readWorkspaceId(req: VercelRequest, _body: JsonRecord): string {
  const context = readWorkspaceContext(req);
  // No context means the router did not authorize this request. Returning the
  // demo sentinel keeps every handler on its non-database branch instead of
  // silently querying with a browser-supplied tenant.
  return context ? context.workspaceId : DEMO_WORKSPACE_ID;
}

/**
 * Who to attribute a journal entry to.
 *
 * Everything here comes from the verified context, never from the body. The one
 * actor field this codebase already had — meta_launch_audit_logs.actor_name —
 * is filled from the request, which means a journal that records whatever the
 * caller claims. This one cannot: the id is the membership the router proved,
 * and the snapshot beside it is the address that JWT belongs to.
 *
 * The snapshot is stored as well as the id because a journal is read years
 * later: a staff row that is renamed, or deactivated and no longer listed,
 * would otherwise turn every past entry into «Сотрудник».
 */
function journalActor(req: VercelRequest): {
  actorName: string;
  actorRole: string;
  actorStaffUserId: string;
  actorKind: "manual";
} {
  const context = readWorkspaceContext(req);
  return {
    actorName: readString(context?.email),
    actorRole: readString(context?.role),
    actorStaffUserId: readString(context?.staffUserId),
    // Everything reaching this pipeline is a signed-in member acting in the
    // CRM. Webhooks file leads through lib/crm/inbound-whatsapp.ts, which does
    // not pass through here — when that path starts journaling, it passes
    // "integration" and the timeline can finally tell the two apart.
    actorKind: "manual",
  };
}

function validationDetails(body: JsonRecord, fields: string[]): string[] {
  return fields
    .filter((field) => !readString(body[field]))
    .map((field) => `${field} is required`);
}

function resourceValidationDetails(resource: CrmResource, body: JsonRecord): string[] {
  const details: string[] = [];

  if (resource === "clients" && !firstString(body.name, body.full_name, body.fullName)) {
    details.push("name is required");
  }

  if (resource === "tasks") {
    if (hasAnyKey(body, ["status"]) && !canonicalTaskStatus(body.status)) {
      details.push("status must be one of: new, in_progress, done");
    }
    if (hasAnyKey(body, ["priority"]) && !canonicalTaskPriority(body.priority)) {
      details.push("priority must be one of: low, medium, high");
    }
  }

  if (resource === "leads" && !firstString(body.name, body.full_name, body.fullName, body.phone)) {
    details.push("name or phone is required");
  }

  if (resource === "deals") {
    if (!readString(body.title)) details.push("title is required");
    const amount = readNumber(body.amountMinor ?? body.amount_minor);
    if (typeof amount === "number" && amount < 0) details.push("amountMinor must be >= 0");
    const status = readString(body.status).toLowerCase();
    if (status && !DEAL_STATUSES.has(status)) details.push("status must be one of pending, paid, cancelled, refunded");
  }

  if (resource === "lead-stages") {
    if (!firstString(body.stageKey, body.stage_key)) details.push("stageKey is required");
    if (!readString(body.name)) details.push("name is required");
    const semanticGroup = firstString(body.semanticGroup, body.semantic_group);
    if (!semanticGroup) {
      details.push("semanticGroup is required");
    } else if (!["new", "in_progress", "booked", "lost"].includes(semanticGroup)) {
      details.push("semanticGroup must be new, in_progress, booked or lost");
    }
  }

  if (resource === "lead-sources") {
    if (!firstString(body.sourceKey, body.source_key)) details.push("sourceKey is required");
    if (!readString(body.name)) details.push("name is required");
  }

  if (resource === "appointments" && !firstString(body.client, body.client_name, body.clientName)) {
    details.push("client is required");
  }

  if (resource === "calls" && !readString(body.phone)) {
    details.push("phone is required");
  }

  if (resource === "tasks" && !readString(body.title)) {
    details.push("title is required");
  }

  if (resource === "chat" && !firstString(body.text, body.message)) {
    details.push("message is required");
  }

  if (resource === "staff") {
    if (!firstString(body.name, body.full_name, body.fullName)) details.push("name is required");
    if (!readString(body.email)) details.push("email is required");
  }

  if (resource === "content-videos" && !readString(body.title)) {
    details.push("title is required");
  }

  if (resource === "admin-settings" && !readString(body.key)) {
    details.push("key is required");
  }

  if (resource === "integration-statuses" && !readString(body.provider)) {
    details.push("provider is required");
  }

  if (resource === "ai-providers") {
    if (!readString(body.provider)) details.push("provider is required");
    if (!readString(body.purpose)) details.push("purpose is required");
  }

  if (resource === "release-checks" && !firstString(body.checkKey, body.check_key)) {
    details.push("checkKey is required");
  }

  if (resource === "meta-launches" && !firstString(body.campaignName, body.campaign_name)) {
    details.push("campaignName is required");
  }

  return details;
}

function envStatus(keys: string[]) {
  const configured = keys.filter((key) => Boolean(process.env[key]?.trim()));
  const status =
    configured.length === keys.length
      ? "configured"
      : configured.length > 0
        ? "partial"
        : "not_configured";

  // Security-2C: only the coarse count is reported. The per-key array named
  // every environment variable the deployment expects, which told a reader
  // exactly which secrets exist and which are missing.
  return {
    status,
    configured: configured.length,
    total: keys.length,
  };
}

function singleEnvStatus(key: string) {
  return envStatus([key]);
}

function readEnvValue(key: string): string {
  return process.env[key]?.trim() || "";
}

function supabaseWarning(scope: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${scope} Supabase persistence skipped: ${detail}`;
}

/**
 * Security-2F: what a caller may be told about a database or storage failure.
 *
 * These handlers echoed the text Postgres and Supabase Storage produce —
 * constraint and table names, "permission denied for table x", row-level
 * security policy messages — to any authenticated member. The router has said
 * since Security-2B that "nothing about the workspace, the membership or the
 * underlying Supabase failure reaches the caller"; that was true of the auth
 * errors and never of the data path.
 *
 * The detail still reaches the server log, where an operator can read it
 * against a request; the caller gets the fallback and nothing else.
 */
const SERVICE_FAILURE_DETAIL = "Сбой на стороне сервиса. Подробности записаны в логах сервера.";

function redactedDetail(scope: string, error: unknown, fallback: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[crm] ${scope} failed: ${detail}`);
  return fallback;
}

function makeClient(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("client"),
    name: firstString(body.name, body.full_name, body.fullName),
    phone: readString(body.phone),
    whatsapp: readString(body.whatsapp),
    source: readString(body.source),
    status: readString(body.status) || "new",
    comment: firstString(body.comment, body.notes),
    lastVisit: firstString(body.lastVisit, body.last_visit_at),
    createdAt: firstString(body.createdAt, body.created_at),
    updatedAt: firstString(body.updatedAt, body.updated_at),
  };
}

function makeLeadStage(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("lead-stage"),
    stageKey: firstString(body.stageKey, body.stage_key),
    name: readString(body.name),
    color: readString(body.color),
    semanticGroup: firstString(body.semanticGroup, body.semantic_group) || "new",
    sortOrder: readNumber(body.sortOrder ?? body.sort_order) ?? 0,
    isDefault: readBoolean(body.isDefault ?? body.is_default),
    isActive: hasAnyKey(body, ["isActive", "is_active"]) ? readBoolean(body.isActive ?? body.is_active) : true,
    createdAt: firstString(body.createdAt, body.created_at),
    updatedAt: firstString(body.updatedAt, body.updated_at),
  };
}

function makeLeadSource(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("lead-source"),
    sourceKey: firstString(body.sourceKey, body.source_key),
    name: readString(body.name),
    channel: readString(body.channel),
    color: readString(body.color),
    sortOrder: readNumber(body.sortOrder ?? body.sort_order) ?? 0,
    isDefault: readBoolean(body.isDefault ?? body.is_default),
    isActive: hasAnyKey(body, ["isActive", "is_active"]) ? readBoolean(body.isActive ?? body.is_active) : true,
    createdAt: firstString(body.createdAt, body.created_at),
    updatedAt: firstString(body.updatedAt, body.updated_at),
  };
}

function makeLead(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("lead"),
    name: firstString(body.name, body.full_name, body.fullName),
    phone: readString(body.phone),
    source: readString(body.source),
    campaign: readString(body.campaign),
    status: readString(body.status) || "new",
    owner: firstString(body.owner, body.responsibleName, body.assignee_name),
    notes: readString(body.notes),
    responsibleUserId: firstString(body.responsibleUserId, body.responsible_user_id),
    clientId: firstString(body.clientId, body.client_id),
    stageId: firstString(body.stageId, body.stage_id),
    stageName: firstString(body.stageName, body.stage_name),
    stageKey: firstString(body.stageKey, body.stage_key),
    stageColor: firstString(body.stageColor, body.stage_color),
    semanticGroup: firstString(body.semanticGroup, body.semantic_group),
    sourceId: firstString(body.sourceId, body.source_id),
    sourceName: firstString(body.sourceName, body.source_name),
    sourceKey: firstString(body.sourceKey, body.source_key),
    sourceChannel: firstString(body.sourceChannel, body.source_channel),
    sourceColor: firstString(body.sourceColor, body.source_color),
    metaCampaignLaunchId: firstString(body.metaCampaignLaunchId, body.meta_campaign_launch_id),
    createdAt: firstString(body.createdAt, body.created_at),
    updatedAt: firstString(body.updatedAt, body.updated_at),
  };
}

// CRM9 — clinic sales/deals. UI term is «Продажи»; a "deal" carries the full
// lifecycle. Only status = paid counts as revenue (by paid_at). No ad-efficiency math.
const DEAL_STATUSES = new Set(["pending", "paid", "cancelled", "refunded"]);

function normalizeDealStatus(raw: unknown): string {
  const status = readString(raw).toLowerCase();
  return DEAL_STATUSES.has(status) ? status : "pending";
}

function readDealAmountMinor(body: JsonRecord): number {
  const amount = readNumber(body.amountMinor ?? body.amount_minor);
  return Math.max(0, Math.round(typeof amount === "number" ? amount : 0));
}

// paid stamps paid_at; every terminal status stamps closed_at. Explicit values win;
// pending never invents timestamps (and PATCH never auto-clears history).
function dealStatusTimestamps(status: string, paidAt: unknown, closedAt: unknown): { paid_at: string | null; closed_at: string | null } {
  const now = new Date().toISOString();
  return {
    paid_at: maybeDate(paidAt) ?? (status === "paid" ? now : null),
    closed_at: maybeDate(closedAt) ?? (status !== "pending" ? now : null),
  };
}

function makeDeal(body: JsonRecord): JsonRecord {
  const status = normalizeDealStatus(body.status);
  const timestamps = dealStatusTimestamps(status, body.paidAt ?? body.paid_at, body.closedAt ?? body.closed_at);
  return {
    id: readString(body.id) || nextDemoId("deal"),
    workspaceId: firstString(body.workspaceId, body.workspace_id),
    title: readString(body.title),
    amountMinor: readDealAmountMinor(body),
    currency: readString(body.currency).toUpperCase() || "KZT",
    status,
    paidAt: timestamps.paid_at,
    closedAt: timestamps.closed_at,
    paymentMethod: firstString(body.paymentMethod, body.payment_method),
    clientId: firstString(body.clientId, body.client_id),
    leadId: firstString(body.leadId, body.lead_id),
    appointmentId: firstString(body.appointmentId, body.appointment_id),
    metaCampaignLaunchId: firstString(body.metaCampaignLaunchId, body.meta_campaign_launch_id),
    responsibleUserId: firstString(body.responsibleUserId, body.responsible_user_id),
    notes: readString(body.notes),
    createdAt: firstString(body.createdAt, body.created_at, new Date().toISOString()),
    updatedAt: firstString(body.updatedAt, body.updated_at, new Date().toISOString()),
  };
}

function makeAppointment(body: JsonRecord): JsonRecord {
  const startsAt = firstString(body.startsAt, body.starts_at, body.time);
  const phone = firstString(body.phone, body.client_phone, body.clientPhone);

  return {
    id: readString(body.id) || nextDemoId("appointment"),
    time: startsAt,
    startsAt,
    client: firstString(body.client, body.client_name, body.clientName),
    phone,
    whatsapp: firstString(body.whatsapp, phone),
    service: readString(body.service),
    doctor: firstString(body.doctor, body.doctor_name, body.doctorName),
    status: readString(body.status) || "scheduled",
    notes: readString(body.notes),
    durationMinutes: readNumber(body.durationMinutes ?? body.duration_minutes) ?? 60,
    duration_minutes: readNumber(body.durationMinutes ?? body.duration_minutes) ?? 60,
    source: readString(body.source),
    clientId: firstString(body.clientId, body.client_id),
  };
}

function makeCall(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("call"),
    time: firstString(body.time, body.call_time),
    phone: readString(body.phone),
    client: firstString(body.client, body.client_name, body.clientName),
    type: firstString(body.type, body.direction),
    source: readString(body.source),
    result: readString(body.result),
    summary: readString(body.summary),
    clientId: firstString(body.clientId, body.client_id),
  };
}

/**
 * Канонические словари задачи.
 *
 * У колонок нет CHECK, а демо-экран писал в ту же колонку русские подписи
 * («Новые», «Готово») поверх английских значений по умолчанию из 010. Со
 * временем в одном столбце оказались бы оба словаря — и индекс по status,
 * построенный там же, считал бы по половине. Ключ хранится канонический,
 * подпись живёт на экране: ровно так устроены стадии заявки.
 */
const TASK_STATUSES = ["new", "in_progress", "done"] as const;
const TASK_PRIORITIES = ["low", "medium", "high"] as const;

/** Русские написания, которые уже могли попасть в базу с демо-экрана. */
const TASK_STATUS_ALIASES: Record<string, string> = {
  "новые": "new",
  "новая": "new",
  "в работе": "in_progress",
  "готово": "done",
  "выполнено": "done",
  "завершено": "done",
  todo: "new",
  open: "new",
  progress: "in_progress",
  completed: "done",
  closed: "done",
};

const TASK_PRIORITY_ALIASES: Record<string, string> = {
  "низкий": "low",
  "средний": "medium",
  "высокий": "high",
  normal: "medium",
  urgent: "high",
};

/**
 * Приводит написание к канону — или отказывает.
 *
 * Возвращает null на то, чего в словаре нет. Прежняя версия молча отдавала
 * «new», и это было хуже, чем кажется: опечатка в PATCH понижала задачу из
 * «В работе» обратно в «Новые» и стирала время закрытия, отвечая 200, а тот
 * же мусор в фильтре возвращал уверенно неверный список вместо 400 — при том
 * что соседний параметр с плохим uuid в трёх строках выше честно отвечает 400.
 */
function canonicalTaskStatus(value: unknown): string | null {
  const raw = readString(value).toLowerCase();
  if (!raw) return null;
  if ((TASK_STATUSES as readonly string[]).includes(raw)) return raw;
  return TASK_STATUS_ALIASES[raw] ?? null;
}

function canonicalTaskPriority(value: unknown): string | null {
  const raw = readString(value).toLowerCase();
  if (!raw) return null;
  if ((TASK_PRIORITIES as readonly string[]).includes(raw)) return raw;
  return TASK_PRIORITY_ALIASES[raw] ?? null;
}

function makeTask(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("task"),
    title: readString(body.title),
    description: readString(body.description),
    owner: firstString(body.owner, body.assignee_name, body.assigneeName),
    deadline: firstString(body.deadline, body.due_at),
    // Значение отдаётся как есть. makeTask обслуживает и fromRow, поэтому
    // канонизация здесь переписывала бы то, что лежит в базе, на пути ЧТЕНИЯ —
    // а единственный экран задач сравнивает статус с русскими подписями и
    // веткой не тронут. Все три колонки доски опустели бы разом. Канон живёт
    // на записи; хранимые русские написания приводит миграция 031.
    priority: readString(body.priority) || "medium",
    status: readString(body.status) || "new",
    assigneeUserId: firstString(body.assigneeUserId, body.assignee_user_id),
    leadId: firstString(body.leadId, body.lead_id),
    clientId: firstString(body.clientId, body.client_id),
    appointmentId: firstString(body.appointmentId, body.appointment_id),
    completedAt: firstString(body.completedAt, body.completed_at),
    createdByKind: firstString(body.createdByKind, body.created_by_kind),
  };
}

function makeChatMessage(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("message"),
    dialog: firstString(body.dialog, body.channel, "general"),
    author: firstString(body.author, body.sender_name, body.senderName, "Сотрудник"),
    role: firstString(body.role, body.sender_role, body.senderRole),
    text: firstString(body.text, body.message),
    time: firstString(body.time, body.created_at),
  };
}

function makeStaffUser(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("staff"),
    name: firstString(body.name, body.full_name, body.fullName),
    email: readString(body.email).toLowerCase(),
    phone: readString(body.phone),
    role: readString(body.role) || "receptionist",
    status: readString(body.status) || "active",
    workspaceId: firstString(body.workspaceId, body.workspace_id),
    authUserId: firstString(body.authUserId, body.auth_user_id),
    temporaryPasswordSet: Boolean(body.temporaryPasswordSet ?? body.temporary_password_set ?? false),
    invitedAt: firstString(body.invitedAt, body.invited_at),
    lastLoginAt: firstString(body.lastLoginAt, body.last_login_at),
    passwordResetRequired: Boolean(body.passwordResetRequired ?? body.password_reset_required ?? false),
  };
}

function makeContentVideo(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("content"),
    title: readString(body.title),
    niche: readString(body.niche),
    goal: readString(body.goal),
    duration: readString(body.duration),
    style: readString(body.style),
    audience: readString(body.audience),
    hook: readString(body.hook),
    script: readString(body.script),
    voiceover: readString(body.voiceover),
    cta: readString(body.cta),
    caption: readString(body.caption),
    hashtags: readJsonArray(body.hashtags),
    avatarPrompt: firstString(body.avatarPrompt, body.avatar_prompt),
    tapnowPrompt: firstString(body.tapnowPrompt, body.tapnow_prompt),
    status: readString(body.status) || "idea",
    createdAt: firstString(body.createdAt, body.created_at, new Date().toISOString()),
  };
}

function makeAdminSetting(body: JsonRecord): JsonRecord {
  const value = asRecord(body.value ?? body.config ?? body.settings);
  return {
    id: readString(body.id) || nextDemoId("setting"),
    key: readString(body.key) || "clinic",
    value,
    config: value,
    updatedAt: firstString(body.updatedAt, body.updated_at, new Date().toISOString()),
  };
}

function makeIntegrationStatus(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("integration"),
    provider: readString(body.provider) || "unknown",
    status: readString(body.status) || "not_configured",
    maskedIdentifier: firstString(body.maskedIdentifier, body.masked_identifier),
    lastCheckedAt: firstString(body.lastCheckedAt, body.last_checked_at),
    lastError: firstString(body.lastError, body.last_error),
    metadata: asRecord(body.metadata),
  };
}

function makeAiProvider(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("ai-provider"),
    provider: readString(body.provider) || "demo",
    purpose: readString(body.purpose) || "content_text",
    enabled: readBoolean(body.enabled),
    modelName: firstString(body.modelName, body.model_name),
    config: asRecord(body.config),
  };
}

function makeMetaAccount(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("meta-account"),
    metaBusinessId: firstString(body.metaBusinessId, body.meta_business_id),
    adAccountId: firstString(body.adAccountId, body.ad_account_id),
    pageId: firstString(body.pageId, body.page_id),
    instagramActorId: firstString(body.instagramActorId, body.instagram_actor_id),
    accountName: firstString(body.accountName, body.account_name),
    currency: readString(body.currency) || "USD",
    timezoneName: firstString(body.timezoneName, body.timezone_name),
    status: readString(body.status) || "draft",
    metadata: asRecord(body.metadata),
  };
}

function makeMetaLaunch(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("meta-launch"),
    workspaceId: firstString(body.workspaceId, body.workspace_id),
    launchedBy: firstString(body.launchedBy, body.launched_by),
    launchedByRole: firstString(body.launchedByRole, body.launched_by_role),
    sourceModule: firstString(body.sourceModule, body.source_module),
    sourceId: firstString(body.sourceId, body.source_id),
    campaignName: firstString(body.campaignName, body.campaign_name),
    objective: readString(body.objective) || "OUTCOME_LEADS",
    status: readString(body.status) || "draft",
    metaCampaignId: firstString(body.metaCampaignId, body.meta_campaign_id),
    metaAdSetId: firstString(body.metaAdSetId, body.meta_adset_id),
    metaCreativeId: firstString(body.metaCreativeId, body.meta_creative_id),
    metaAdId: firstString(body.metaAdId, body.meta_ad_id),
    metaVideoId: firstString(body.metaVideoId, body.meta_video_id, body.videoId, body.video_id, asRecord(body.metaResponse ?? body.meta_response).videoId),
    metaStatus: firstString(body.metaStatus, body.meta_status),
    budgetDailyMinor: readNumber(body.budgetDailyMinor ?? body.budget_daily_minor) ?? null,
    budgetTotalMinor: readNumber(body.budgetTotalMinor ?? body.budget_total_minor) ?? null,
    currency: readString(body.currency) || "USD",
    startTime: firstString(body.startTime, body.start_time),
    endTime: firstString(body.endTime, body.end_time),
    pageId: firstString(body.pageId, body.page_id),
    instagramActorId: firstString(body.instagramActorId, body.instagram_actor_id),
    adAccountId: firstString(body.adAccountId, body.ad_account_id),
    payload: asRecord(body.payload),
    compliance: asRecord(body.compliance),
    metaResponse: asRecord(body.metaResponse ?? body.meta_response),
    lastError: firstString(body.lastError, body.last_error),
    createdAt: firstString(body.createdAt, body.created_at, new Date().toISOString()),
    updatedAt: firstString(body.updatedAt, body.updated_at, new Date().toISOString()),
  };
}

function normalizeCreativeFileType(body: JsonRecord): "image" | "video" {
  const explicit = firstString(body.fileType, body.file_type, body.creativeType, body.creative_type).toLowerCase();
  const mimeType = firstString(body.mimeType, body.mime_type).toLowerCase();
  if (explicit === "video" || mimeType.startsWith("video/")) return "video";
  return "image";
}

function makeAdCreativeAsset(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("ad-creative"),
    workspaceId: firstString(body.workspaceId, body.workspace_id),
    launchId: firstString(body.launchId, body.launch_id),
    uploadedBy: firstString(body.uploadedBy, body.uploaded_by),
    fileName: firstString(body.fileName, body.file_name),
    fileType: normalizeCreativeFileType(body),
    mimeType: firstString(body.mimeType, body.mime_type),
    fileSize: readNumber(body.fileSize ?? body.file_size) ?? null,
    storageBucket: firstString(body.storageBucket, body.storage_bucket, "ad-creatives"),
    storagePath: firstString(body.storagePath, body.storage_path),
    publicUrl: resolveAdCreativePublicUrl(body),
    metaAssetId: firstString(body.metaAssetId, body.meta_asset_id),
    metaVideoId: firstString(body.metaVideoId, body.meta_video_id, body.videoId, body.video_id),
    status: readString(body.status) || "uploaded",
    metadata: asRecord(body.metadata),
    createdAt: firstString(body.createdAt, body.created_at, new Date().toISOString()),
    updatedAt: firstString(body.updatedAt, body.updated_at, new Date().toISOString()),
  };
}

function makeReleaseCheck(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("release-check"),
    checkKey: firstString(body.checkKey, body.check_key),
    status: readString(body.status) || "pending",
    notes: readString(body.notes),
    checkedAt: firstString(body.checkedAt, body.checked_at),
  };
}

const configs: Record<CrmResource, ResourceConfig> = {
  clients: {
    table: "clients",
    listKey: "clients",
    requiredPost: [],
    sortableColumn: "created_at",
    demoItem: makeClient,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      full_name: firstString(body.name, body.full_name, body.fullName),
      phone: readString(body.phone) || null,
      whatsapp: readString(body.whatsapp) || null,
      source: readString(body.source) || null,
      status: readString(body.status) || "new",
      notes: firstString(body.comment, body.notes) || null,
      last_visit_at: maybeDate(body.lastVisit ?? body.last_visit_at),
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeClient({
        id: row.id,
        name: row.full_name,
        phone: row.phone,
        whatsapp: row.whatsapp,
        source: row.source,
        status: row.status,
        comment: row.notes,
        lastVisit: row.last_visit_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }),
  },
  leads: {
    table: "leads",
    listKey: "leads",
    requiredPost: [],
    sortableColumn: "created_at",
    selectColumns:
      "*,stage_definition:lead_stages(id,stage_key,name,color,semantic_group,sort_order,is_default,is_active),source_definition:lead_sources(id,source_key,name,channel,color,sort_order,is_default,is_active)",
    demoItem: makeLead,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      full_name: firstString(body.name, body.full_name, body.fullName) || null,
      phone: readString(body.phone) || null,
      source: readString(body.source) || null,
      campaign: readString(body.campaign) || null,
      status: readString(body.status) || "new",
      // notes holds real notes only — the responsible person lives in
      // responsible_user_id (a staff_users FK), never overloaded into notes.
      notes: readString(body.notes) || null,
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) => {
      const stage = asRelatedRecord(row.stage_definition);
      const source = asRelatedRecord(row.source_definition);

      return makeLead({
        id: row.id,
        name: row.full_name,
        phone: row.phone,
        source: row.source,
        campaign: row.campaign,
        status: row.status,
        notes: row.notes,
        responsible_user_id: row.responsible_user_id,
        client_id: row.client_id,
        stage_id: row.stage_id,
        stage_name: stage.name,
        stage_key: stage.stage_key,
        stage_color: stage.color,
        semantic_group: stage.semantic_group,
        source_id: row.source_id,
        source_name: source.name,
        source_key: source.source_key,
        source_channel: source.channel,
        source_color: source.color,
        meta_campaign_launch_id: row.meta_campaign_launch_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    },
  },
  "lead-stages": {
    table: "lead_stages",
    listKey: "stages",
    requiredPost: [],
    sortableColumn: "sort_order",
    sortableAscending: true,
    demoItem: makeLeadStage,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      stage_key: firstString(body.stageKey, body.stage_key),
      name: readString(body.name),
      color: readString(body.color) || null,
      semantic_group: firstString(body.semanticGroup, body.semantic_group),
      sort_order: readNumber(body.sortOrder ?? body.sort_order) ?? 0,
      is_default: readBoolean(body.isDefault ?? body.is_default),
      is_active: hasAnyKey(body, ["isActive", "is_active"]) ? readBoolean(body.isActive ?? body.is_active) : true,
      updated_at: new Date().toISOString(),
    }),
    fromRow: makeLeadStage,
  },
  "lead-sources": {
    table: "lead_sources",
    listKey: "sources",
    requiredPost: [],
    sortableColumn: "sort_order",
    sortableAscending: true,
    demoItem: makeLeadSource,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      source_key: firstString(body.sourceKey, body.source_key),
      name: readString(body.name),
      channel: readString(body.channel) || null,
      color: readString(body.color) || null,
      sort_order: readNumber(body.sortOrder ?? body.sort_order) ?? 0,
      is_default: readBoolean(body.isDefault ?? body.is_default),
      is_active: hasAnyKey(body, ["isActive", "is_active"]) ? readBoolean(body.isActive ?? body.is_active) : true,
      updated_at: new Date().toISOString(),
    }),
    fromRow: makeLeadSource,
  },
  deals: {
    table: "deals",
    listKey: "deals",
    requiredPost: [],
    sortableColumn: "created_at",
    demoItem: makeDeal,
    // Reference columns (client_id/lead_id/appointment_id/meta_campaign_launch_id/
    // responsible_user_id) are written only through buildDealReferenceRow, which
    // validates that every referenced row belongs to the same workspace.
    toRow: (body, workspaceId) => {
      const status = normalizeDealStatus(body.status);
      const timestamps = dealStatusTimestamps(status, body.paidAt ?? body.paid_at, body.closedAt ?? body.closed_at);
      return {
        workspace_id: workspaceId,
        title: readString(body.title),
        amount_minor: readDealAmountMinor(body),
        currency: readString(body.currency).toUpperCase() || "KZT",
        status,
        paid_at: timestamps.paid_at,
        closed_at: timestamps.closed_at,
        payment_method: firstString(body.paymentMethod, body.payment_method) || null,
        notes: readString(body.notes) || null,
        updated_at: new Date().toISOString(),
      };
    },
    fromRow: (row) =>
      makeDeal({
        id: row.id,
        workspace_id: row.workspace_id,
        title: row.title,
        amount_minor: row.amount_minor,
        currency: row.currency,
        status: row.status,
        paid_at: row.paid_at,
        closed_at: row.closed_at,
        payment_method: row.payment_method,
        client_id: row.client_id,
        lead_id: row.lead_id,
        appointment_id: row.appointment_id,
        meta_campaign_launch_id: row.meta_campaign_launch_id,
        responsible_user_id: row.responsible_user_id,
        notes: row.notes,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }),
  },
  appointments: {
    table: "appointments",
    listKey: "appointments",
    requiredPost: [],
    sortableColumn: "created_at",
    demoItem: makeAppointment,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      client_name: firstString(body.client, body.client_name, body.clientName) || null,
      client_phone: firstString(body.phone, body.client_phone, body.clientPhone) || null,
      whatsapp: readString(body.whatsapp) || null,
      service: readString(body.service) || null,
      doctor_name: firstString(body.doctor, body.doctor_name, body.doctorName) || null,
      starts_at: maybeDate(body.starts_at ?? body.startsAt),
      duration_minutes: appointmentMinutes(body.durationMinutes ?? body.duration_minutes),
      status: readString(body.status) || "scheduled",
      notes: firstString(body.notes, body.time) || null,
      source: readString(body.source) || null,
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeAppointment({
        id: row.id,
        client: row.client_name,
        phone: row.client_phone,
        whatsapp: row.whatsapp,
        service: row.service,
        doctor: row.doctor_name,
        startsAt: row.starts_at,
        time: row.starts_at || row.notes,
        status: row.status,
        notes: row.notes,
        durationMinutes: row.duration_minutes,
        source: row.source,
        client_id: row.client_id,
      }),
  },
  calls: {
    table: "calls",
    listKey: "calls",
    requiredPost: [],
    sortableColumn: "created_at",
    demoItem: makeCall,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      phone: readString(body.phone) || null,
      direction: firstString(body.type, body.direction) || null,
      source: readString(body.source) || null,
      result: readString(body.result) || null,
      summary: readString(body.summary) || null,
      call_time: maybeDate(body.call_time ?? body.callTime) || new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeCall({
        id: row.id,
        time: row.call_time,
        phone: row.phone,
        type: row.direction,
        source: row.source,
        result: row.result,
        summary: row.summary,
        client_id: row.client_id,
      }),
  },
  tasks: {
    table: "tasks",
    listKey: "tasks",
    requiredPost: [],
    sortableColumn: "created_at",
    demoItem: makeTask,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      title: readString(body.title),
      description: readString(body.description) || null,
      assignee_name: firstString(body.owner, body.assignee_name, body.assigneeName) || null,
      priority: canonicalTaskPriority(body.priority) ?? "medium",
      status: canonicalTaskStatus(body.status) ?? "new",
      // `deadline` читается и здесь. PATCH принимал его с самого начала, POST —
      // нет, поэтому задача, созданная в интерфейсе со сроком, ложилась в базу
      // с due_at = null: на экране срок был, в базе его не было. В демо-режиме
      // баг невидим — там ответ собирает makeTask, который deadline читает, —
      // и ровно поэтому он дожил до сих пор.
      due_at: maybeDate(body.deadline ?? body.due_at ?? body.dueAt),
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeTask({
        id: row.id,
        title: row.title,
        description: row.description,
        owner: row.assignee_name,
        priority: row.priority,
        status: row.status,
        deadline: row.due_at,
        assigneeUserId: row.assignee_user_id,
        leadId: row.lead_id,
        clientId: row.client_id,
        appointmentId: row.appointment_id,
        completedAt: row.completed_at,
        createdByKind: row.created_by_kind,
      }),
  },
  chat: {
    table: "chat_messages",
    listKey: "messages",
    requiredPost: [],
    sortableColumn: "created_at",
    demoItem: makeChatMessage,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      channel: firstString(body.dialog, body.channel, "general"),
      sender_name: firstString(body.author, body.sender_name, body.senderName, "Сотрудник"),
      sender_role: firstString(body.role, body.sender_role, body.senderRole) || null,
      message: firstString(body.text, body.message),
    }),
    fromRow: (row) =>
      makeChatMessage({
        id: row.id,
        dialog: row.channel,
        author: row.sender_name,
        role: row.sender_role,
        text: row.message,
        time: row.created_at,
      }),
  },
  staff: {
    table: "staff_users",
    listKey: "staff",
    requiredPost: [],
    sortableColumn: "created_at",
    demoItem: makeStaffUser,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      full_name: firstString(body.name, body.full_name, body.fullName),
      email: readString(body.email).toLowerCase(),
      phone: readString(body.phone) || null,
      role: readString(body.role) || "receptionist",
      status: readString(body.status) || "active",
      auth_user_id: firstString(body.authUserId, body.auth_user_id) || null,
      temporary_password_set: Boolean(body.temporaryPasswordSet ?? body.temporary_password_set ?? false),
      invited_at: maybeDate(body.invitedAt ?? body.invited_at),
      last_login_at: maybeDate(body.lastLoginAt ?? body.last_login_at),
      password_reset_required: Boolean(body.passwordResetRequired ?? body.password_reset_required ?? false),
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeStaffUser({
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.full_name,
        email: row.email,
        phone: row.phone,
        role: row.role,
        status: row.status,
        authUserId: row.auth_user_id,
        temporaryPasswordSet: row.temporary_password_set,
        invitedAt: row.invited_at,
        lastLoginAt: row.last_login_at,
        passwordResetRequired: row.password_reset_required,
      }),
  },
  "content-videos": {
    table: "content_videos",
    listKey: "videos",
    requiredPost: [],
    sortableColumn: "created_at",
    demoItem: makeContentVideo,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      title: readString(body.title),
      niche: readString(body.niche) || null,
      goal: readString(body.goal) || null,
      duration: readString(body.duration) || null,
      style: readString(body.style) || null,
      audience: readString(body.audience) || null,
      hook: readString(body.hook) || null,
      script: readString(body.script) || null,
      voiceover: readString(body.voiceover) || null,
      cta: readString(body.cta) || null,
      caption: readString(body.caption) || null,
      hashtags: readJsonArray(body.hashtags),
      avatar_prompt: firstString(body.avatarPrompt, body.avatar_prompt) || null,
      tapnow_prompt: firstString(body.tapnowPrompt, body.tapnow_prompt) || null,
      status: readString(body.status) || "idea",
      raw_payload: body,
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeContentVideo({
        id: row.id,
        title: row.title,
        niche: row.niche,
        goal: row.goal,
        duration: row.duration,
        style: row.style,
        audience: row.audience,
        hook: row.hook,
        script: row.script,
        voiceover: row.voiceover,
        cta: row.cta,
        caption: row.caption,
        hashtags: row.hashtags,
        avatarPrompt: row.avatar_prompt,
        tapnowPrompt: row.tapnow_prompt,
        status: row.status,
        createdAt: row.created_at,
      }),
  },
  "admin-settings": {
    table: "workspace_settings",
    listKey: "settings",
    requiredPost: [],
    sortableColumn: "updated_at",
    upsertConflict: "workspace_id,key",
    demoItem: makeAdminSetting,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      key: readString(body.key) || "clinic",
      value: asRecord(body.value ?? body.config ?? body.settings),
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeAdminSetting({
        id: row.id,
        key: row.key,
        value: row.value,
        updatedAt: row.updated_at,
      }),
  },
  "integration-statuses": {
    table: "integration_statuses",
    listKey: "integrations",
    requiredPost: [],
    sortableColumn: "updated_at",
    upsertConflict: "workspace_id,provider",
    demoItem: makeIntegrationStatus,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      provider: readString(body.provider),
      status: readString(body.status) || "not_configured",
      masked_identifier: firstString(body.maskedIdentifier, body.masked_identifier) || null,
      last_checked_at: maybeDate(body.lastCheckedAt ?? body.last_checked_at) || new Date().toISOString(),
      last_error: firstString(body.lastError, body.last_error) || null,
      metadata: asRecord(body.metadata),
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeIntegrationStatus({
        id: row.id,
        provider: row.provider,
        status: row.status,
        maskedIdentifier: row.masked_identifier,
        lastCheckedAt: row.last_checked_at,
        lastError: row.last_error,
        metadata: row.metadata,
      }),
  },
  "ai-providers": {
    table: "ai_provider_settings",
    listKey: "providers",
    requiredPost: [],
    sortableColumn: "updated_at",
    upsertConflict: "workspace_id,provider,purpose",
    demoItem: makeAiProvider,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      provider: readString(body.provider),
      purpose: readString(body.purpose),
      enabled: readBoolean(body.enabled),
      model_name: firstString(body.modelName, body.model_name) || null,
      config: asRecord(body.config),
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeAiProvider({
        id: row.id,
        provider: row.provider,
        purpose: row.purpose,
        enabled: row.enabled,
        modelName: row.model_name,
        config: row.config,
      }),
  },
  "meta-accounts": {
    table: "meta_ad_accounts",
    listKey: "accounts",
    requiredPost: [],
    sortableColumn: "updated_at",
    demoItem: makeMetaAccount,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      meta_business_id: firstString(body.metaBusinessId, body.meta_business_id) || null,
      ad_account_id: firstString(body.adAccountId, body.ad_account_id) || null,
      page_id: firstString(body.pageId, body.page_id) || null,
      instagram_actor_id: firstString(body.instagramActorId, body.instagram_actor_id) || null,
      account_name: firstString(body.accountName, body.account_name) || null,
      currency: readString(body.currency) || "USD",
      timezone_name: firstString(body.timezoneName, body.timezone_name) || null,
      status: readString(body.status) || "draft",
      metadata: asRecord(body.metadata),
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeMetaAccount({
        id: row.id,
        metaBusinessId: row.meta_business_id,
        adAccountId: row.ad_account_id,
        pageId: row.page_id,
        instagramActorId: row.instagram_actor_id,
        accountName: row.account_name,
        currency: row.currency,
        timezoneName: row.timezone_name,
        status: row.status,
        metadata: row.metadata,
      }),
  },
  "meta-launches": {
    table: "meta_campaign_launches",
    listKey: "launches",
    requiredPost: [],
    sortableColumn: "created_at",
    demoItem: makeMetaLaunch,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      launched_by: firstString(body.launchedBy, body.launched_by) || null,
      launched_by_role: firstString(body.launchedByRole, body.launched_by_role) || null,
      source_module: firstString(body.sourceModule, body.source_module) || null,
      source_id: firstString(body.sourceId, body.source_id) || null,
      campaign_name: firstString(body.campaignName, body.campaign_name),
      objective: readString(body.objective) || "OUTCOME_LEADS",
      status: readString(body.status) || "draft",
      meta_campaign_id: firstString(body.metaCampaignId, body.meta_campaign_id) || null,
      meta_adset_id: firstString(body.metaAdSetId, body.meta_adset_id) || null,
      meta_creative_id: firstString(body.metaCreativeId, body.meta_creative_id) || null,
      meta_ad_id: firstString(body.metaAdId, body.meta_ad_id) || null,
      meta_status: firstString(body.metaStatus, body.meta_status) || null,
      budget_daily_minor: readNumber(body.budgetDailyMinor ?? body.budget_daily_minor),
      budget_total_minor: readNumber(body.budgetTotalMinor ?? body.budget_total_minor),
      currency: readString(body.currency) || "USD",
      start_time: maybeDate(body.startTime ?? body.start_time),
      end_time: maybeDate(body.endTime ?? body.end_time),
      page_id: firstString(body.pageId, body.page_id) || null,
      instagram_actor_id: firstString(body.instagramActorId, body.instagram_actor_id) || null,
      ad_account_id: firstString(body.adAccountId, body.ad_account_id) || null,
      payload: asRecord(body.payload),
      compliance: asRecord(body.compliance),
      meta_response: asRecord(body.metaResponse ?? body.meta_response),
      last_error: firstString(body.lastError, body.last_error) || null,
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeMetaLaunch({
        id: row.id,
        workspaceId: row.workspace_id,
        launchedBy: row.launched_by,
        launchedByRole: row.launched_by_role,
        sourceModule: row.source_module,
        sourceId: row.source_id,
        campaignName: row.campaign_name,
        objective: row.objective,
        status: row.status,
        metaCampaignId: row.meta_campaign_id,
        metaAdSetId: row.meta_adset_id,
        metaCreativeId: row.meta_creative_id,
        metaAdId: row.meta_ad_id,
        metaVideoId: firstString(asRecord(row.meta_response).videoId, asRecord(row.meta_response).metaVideoId),
        metaStatus: row.meta_status,
        budgetDailyMinor: row.budget_daily_minor,
        budgetTotalMinor: row.budget_total_minor,
        currency: row.currency,
        startTime: row.start_time,
        endTime: row.end_time,
        pageId: row.page_id,
        instagramActorId: row.instagram_actor_id,
        adAccountId: row.ad_account_id,
        payload: row.payload,
        compliance: row.compliance,
        metaResponse: row.meta_response,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
  },
  "ad-creatives": {
    table: "ad_creative_assets",
    listKey: "assets",
    requiredPost: [],
    sortableColumn: "created_at",
    demoItem: makeAdCreativeAsset,
    toRow: (body, workspaceId) => {
      const launchId = firstString(body.launchId, body.launch_id);
      return {
        workspace_id: workspaceId,
        launch_id: isUuid(launchId) ? launchId : null,
        uploaded_by: firstString(body.uploadedBy, body.uploaded_by) || null,
        file_name: firstString(body.fileName, body.file_name),
        file_type: normalizeCreativeFileType(body),
        mime_type: firstString(body.mimeType, body.mime_type) || null,
        file_size: readNumber(body.fileSize ?? body.file_size),
        storage_bucket: firstString(body.storageBucket, body.storage_bucket, "ad-creatives"),
        storage_path: firstString(body.storagePath, body.storage_path) || null,
        public_url: resolveAdCreativePublicUrl(body) || null,
        meta_asset_id: firstString(body.metaAssetId, body.meta_asset_id) || null,
        meta_video_id: firstString(body.metaVideoId, body.meta_video_id, body.videoId, body.video_id) || null,
        status: readString(body.status) || "uploaded",
        metadata: asRecord(body.metadata),
        updated_at: new Date().toISOString(),
      };
    },
    fromRow: (row) =>
      makeAdCreativeAsset({
        id: row.id,
        workspaceId: row.workspace_id,
        launchId: row.launch_id,
        uploadedBy: row.uploaded_by,
        fileName: row.file_name,
        fileType: row.file_type,
        mimeType: row.mime_type,
        fileSize: row.file_size,
        storageBucket: row.storage_bucket,
        storagePath: row.storage_path,
        publicUrl: row.public_url,
        metaAssetId: row.meta_asset_id,
        metaVideoId: row.meta_video_id,
        status: row.status,
        metadata: row.metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
  },
  "release-checks": {
    table: "release_checks",
    listKey: "checks",
    requiredPost: [],
    sortableColumn: "created_at",
    upsertConflict: "workspace_id,check_key",
    demoItem: makeReleaseCheck,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      check_key: firstString(body.checkKey, body.check_key),
      status: readString(body.status) || "pending",
      notes: readString(body.notes) || null,
      checked_at: maybeDate(body.checkedAt ?? body.checked_at),
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeReleaseCheck({
        id: row.id,
        checkKey: row.check_key,
        status: row.status,
        notes: row.notes,
        checkedAt: row.checked_at,
      }),
  },
};

function generateTemporaryPassword(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `Negis2026!${suffix}`;
}

async function createSupabaseAuthUser(input: {
  supabase: unknown;
  email: string;
  password: string;
  name: string;
  role: string;
  workspaceId: string;
}): Promise<{ authUserId: string; warning?: string }> {
  const admin = (input.supabase as SupabaseAdminCapableClient).auth?.admin;

  if (!admin?.createUser) {
    return {
      authUserId: "",
      warning: "Supabase Auth admin API is not available in this runtime",
    };
  }

  const result = await admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: {
      full_name: input.name,
      role: input.role,
      workspace_id: input.workspaceId,
    },
  });

  if (result.error) {
    return {
      authUserId: "",
      warning: result.error.message || "Supabase Auth user was not created",
    };
  }

  return {
    authUserId: readString(result.data?.user?.id),
  };
}

type CrmSupabaseClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

async function readWorkspaceReference(input: {
  supabase: CrmSupabaseClient;
  workspaceId: string;
  table: "lead_stages" | "lead_sources" | "meta_campaign_launches" | "clients" | "leads" | "appointments" | "staff_users";
  id: string;
  select: string;
  fieldName: string;
}): Promise<JsonRecord> {
  if (!isUuid(input.id)) {
    throw new CrmReferenceValidationError([`${input.fieldName} must be a valid id`]);
  }

  const { data, error } = await input.supabase
    .from(input.table)
    .select(input.select)
    .eq("id", input.id)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new CrmReferenceValidationError([`${input.fieldName} does not belong to this workspace`]);
  }

  return asRecord(data);
}

async function buildLeadReferenceRow(
  supabase: CrmSupabaseClient,
  workspaceId: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  const row: JsonRecord = {};

  if (hasAnyKey(body, ["stageId", "stage_id"])) {
    const stageId = firstString(body.stageId, body.stage_id);
    if (!stageId) {
      row.stage_id = null;
    } else {
      const stage = await readWorkspaceReference({
        supabase,
        workspaceId,
        table: "lead_stages",
        id: stageId,
        select: "id,stage_key,name",
        fieldName: "stageId",
      });
      row.stage_id = stage.id;
      row.status = firstString(stage.stage_key, stage.name);
    }
  }

  if (hasAnyKey(body, ["sourceId", "source_id"])) {
    const sourceId = firstString(body.sourceId, body.source_id);
    if (!sourceId) {
      row.source_id = null;
    } else {
      const source = await readWorkspaceReference({
        supabase,
        workspaceId,
        table: "lead_sources",
        id: sourceId,
        select: "id,source_key,name",
        fieldName: "sourceId",
      });
      row.source_id = source.id;
      row.source = readString(source.name);
    }
  }

  // Lead → client conversion, and the manual link to an existing client. An
  // empty string is the deliberate unlink. Until now this was written in
  // buildPatchRow guarded only by isUuid — a shape check, not a tenancy check —
  // so a client id from another clinic passed straight into the FK.
  if (hasAnyKey(body, ["clientId", "client_id"])) {
    const clientId = firstString(body.clientId, body.client_id);
    if (!clientId) {
      row.client_id = null;
    } else {
      const client = await readWorkspaceReference({
        supabase,
        workspaceId,
        table: "clients",
        id: clientId,
        select: "id",
        fieldName: "clientId",
      });
      row.client_id = client.id;
    }
  }

  // Who owns this lead. The column has existed since 010 and fromRow has always
  // returned it, but no write path set it: the card could only say «Назначен»
  // or «—», and nothing in the product could put a name there. A clinic with
  // two registrars had no way to divide the queue.
  //
  // Routed through readWorkspaceReference like every other reference, so a
  // staff id from another clinic is refused rather than stored — the FK alone
  // would accept it, since staff_users carries its own workspace_id.
  if (hasAnyKey(body, ["responsibleUserId", "responsible_user_id"])) {
    const responsibleId = firstString(body.responsibleUserId, body.responsible_user_id);
    if (!responsibleId) {
      row.responsible_user_id = null;
    } else {
      const staff = await readWorkspaceReference({
        supabase,
        workspaceId,
        table: "staff_users",
        id: responsibleId,
        select: "id,full_name,status",
        fieldName: "responsibleUserId",
      });
      // A deactivated colleague must not stay assignable: the lead would sit in
      // a queue nobody reads.
      if (readString(staff.status).toLowerCase() !== "active") {
        throw new CrmReferenceValidationError(["responsibleUserId must be an active staff member"]);
      }
      row.responsible_user_id = staff.id;
    }
  }

  if (hasAnyKey(body, ["metaCampaignLaunchId", "meta_campaign_launch_id"])) {
    const campaignId = firstString(body.metaCampaignLaunchId, body.meta_campaign_launch_id);
    if (!campaignId) {
      row.meta_campaign_launch_id = null;
    } else {
      const campaign = await readWorkspaceReference({
        supabase,
        workspaceId,
        table: "meta_campaign_launches",
        id: campaignId,
        select: "id,campaign_name",
        fieldName: "metaCampaignLaunchId",
      });
      row.meta_campaign_launch_id = campaign.id;
      row.campaign = readString(campaign.campaign_name);
    }
  }

  return row;
}

// CRM9: every deal reference must belong to the same workspace as the deal.
// A foreign-workspace or malformed id returns a safe validation error, never
// a raw SQL error. Empty values unlink (null).
/**
 * Two appointments for one doctor at one time.
 *
 * The check existed only in the browser, over the array the page happened to
 * have loaded (AppointmentsPage findConflict). That is wrong twice. It is wrong
 * at scale, because the list read has no limit and is therefore capped by
 * whatever PostgREST is configured with — past that point the conflicting
 * appointment is simply not in the window, and the clinic double-books with no
 * warning at all. And it is wrong at any scale, because two registrars on two
 * devices each hold their own array: neither sees the booking the other made a
 * second ago. A rule enforced only in one browser is not a rule.
 *
 * It stays advisory on purpose. Clinics do overbook deliberately — a doctor
 * takes an urgent case into an occupied slot — so the answer is a refusal the
 * operator can override with an explicit `allowConflict`, not a prohibition.
 * What changes is that the override is now a decision someone made, rather than
 * a gap nobody saw.
 */
export class AppointmentConflictError extends Error {
  readonly conflict: { id: string; startsAt: string; clientName: string; doctorName: string };

  constructor(conflict: { id: string; startsAt: string; clientName: string; doctorName: string }) {
    super("Appointment conflict");
    this.name = "AppointmentConflictError";
    this.conflict = conflict;
  }
}

/**
 * Only these two release the slot; everything else holds it.
 *
 * The first version listed the three occupying statuses instead, and an
 * unknown value therefore freed the time — while the browser normalises
 * anything unknown to «scheduled» and paints it as booked
 * (AppointmentsPage normalizeStatus). Client and server disagreed about the
 * same row, and the unsafe reading was the default: a status the column has no
 * CHECK against, or a NULL left by clearing the field, made an appointment
 * invisible to every future check while it kept its place on the calendar.
 */
const RELEASING_APPOINTMENT_STATUSES = ["cancelled", "no_show"];

function occupiesSlot(status: string): boolean {
  return !RELEASING_APPOINTMENT_STATUSES.includes(status.trim().toLowerCase());
}
const DEFAULT_APPOINTMENT_MINUTES = 60;
/**
 * How far back to look for a booking that could still be running.
 *
 * The overlap itself is computed in code because the end of a visit is
 * `starts_at + duration_minutes`, which PostgREST cannot filter on. So the
 * database narrows by the one thing it has an index for — (doctor_name,
 * starts_at), migration 012 — and the window has to be wide enough to catch a
 * long appointment that began before the candidate. A day is far past any
 * plausible visit and still a handful of rows for one doctor.
 */
const CONFLICT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * One number for the column and for the arithmetic.
 *
 * `readNumber("")` and `readNumber(null)` are 0, which is finite, so the old
 * `?? 60` never caught them: the row stored 0 while the check treated the
 * visit as an hour. The card said «0 мин» and the refusal said the hour was
 * taken. Both sides now go through here.
 */
function appointmentMinutes(value: unknown): number {
  const minutes = readNumber(value);
  return typeof minutes === "number" && minutes > 0 ? minutes : DEFAULT_APPOINTMENT_MINUTES;
}

async function assertNoAppointmentConflict(
  supabase: CrmSupabaseClient,
  workspaceId: string,
  candidate: { id?: string; doctorName: string; startsAt: string; durationMinutes: number; status: string },
): Promise<void> {
  if (!candidate.doctorName || !candidate.startsAt) return;
  // A visit that is cancelled or was a no-show does not hold its slot.
  if (!occupiesSlot(candidate.status)) return;

  const start = Date.parse(candidate.startsAt);
  if (!Number.isFinite(start)) return;
  const end = start + candidate.durationMinutes * 60_000;

  const { data, error } = await supabase
    .from("appointments")
    .select("id, client_name, doctor_name, starts_at, duration_minutes, status")
    .eq("workspace_id", workspaceId)
    .eq("doctor_name", candidate.doctorName)
    .gte("starts_at", new Date(start - CONFLICT_LOOKBACK_MS).toISOString())
    .lt("starts_at", new Date(end).toISOString());

  // A check that cannot run must not become a check that passed. But it must
  // not block the clinic either: the refusal below is advisory, so an
  // unavailable check degrades to the browser's own — the state before this
  // function existed — and says so in the operator log.
  if (error) {
    console.warn("appointments: conflict check unavailable", error.message);
    return;
  }

  for (const raw of Array.isArray(data) ? data : []) {
    const row = asRecord(raw);
    const id = readString(row.id);
    // #4: Postgres compares uuid canonically and renders it lower-case, so a
    // caller passing the same id in upper case would fail to match itself here
    // and the appointment would conflict with itself on every edit.
    if (candidate.id && id.toLowerCase() === candidate.id.toLowerCase()) continue;
    if (!occupiesSlot(readString(row.status))) continue;

    const otherStart = Date.parse(readString(row.starts_at));
    if (!Number.isFinite(otherStart)) continue;
    const otherEnd = otherStart + appointmentMinutes(row.duration_minutes) * 60_000;

    if (start < otherEnd && otherStart < end) {
      throw new AppointmentConflictError({
        id,
        startsAt: readString(row.starts_at),
        clientName: readString(row.client_name),
        doctorName: readString(row.doctor_name),
      });
    }
  }
}

/** The caller states plainly that it means to overbook. Absence is not consent. */
function allowsAppointmentConflict(body: JsonRecord): boolean {
  return body.allowConflict === true || body.allow_conflict === true;
}

/**
 * The appointment's link to the patient it is for.
 *
 * The column has existed since 010 and fromRow has always returned it, but no
 * write path set it — a visit was never attached to the client card, and the
 * clinic's own history of a patient could not include their appointments. Same
 * rule as every reference: the id is looked up inside the acting workspace, so
 * another clinic's client is refused, and an explicit empty string unlinks.
 */
async function buildAppointmentReferenceRow(
  supabase: CrmSupabaseClient,
  workspaceId: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  const row: JsonRecord = {};

  if (hasAnyKey(body, ["clientId", "client_id"])) {
    const clientId = firstString(body.clientId, body.client_id);
    if (!clientId) {
      row.client_id = null;
    } else {
      const client = await readWorkspaceReference({
        supabase,
        workspaceId,
        table: "clients",
        id: clientId,
        select: "id",
        fieldName: "clientId",
      });
      row.client_id = client.id;
    }
  }

  return row;
}

/**
 * What a task is about, and who it is for — each verified inside the clinic.
 *
 * Every reference the CRM stores goes through readWorkspaceReference, and the
 * one that did not — a lead's client_id, guarded by isUuid alone — turned out
 * to accept another clinic's patient id, because a uuid is a shape and not a
 * tenancy. Tasks get four references at once here, so they start on the
 * validated path rather than being repaired onto it later.
 *
 * assignee_user_id has existed since 010 as a real foreign key and has never
 * been written by anything: the server stored only the free-text
 * assignee_name, which is why «мои задачи» was not merely unimplemented but
 * unexpressible — there was no id to compare against. It is filled here, and
 * the display name is kept alongside it as a snapshot, the same way the
 * journal keeps the actor's name.
 */
async function buildTaskReferenceRow(
  supabase: CrmSupabaseClient,
  workspaceId: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  const row: JsonRecord = {};
  const referenceFields: Array<{
    keys: [string, string];
    column: string;
    table: "leads" | "clients" | "appointments" | "staff_users";
    fieldName: string;
  }> = [
    { keys: ["leadId", "lead_id"], column: "lead_id", table: "leads", fieldName: "leadId" },
    { keys: ["clientId", "client_id"], column: "client_id", table: "clients", fieldName: "clientId" },
    { keys: ["appointmentId", "appointment_id"], column: "appointment_id", table: "appointments", fieldName: "appointmentId" },
    { keys: ["assigneeUserId", "assignee_user_id"], column: "assignee_user_id", table: "staff_users", fieldName: "assigneeUserId" },
  ];

  for (const field of referenceFields) {
    if (!hasAnyKey(body, field.keys)) continue;
    const raw = body[field.keys[0]] ?? body[field.keys[1]];
    // Отвязка — это ЯВНАЯ пустая строка. Число, булево или объект попадали бы
    // в ту же ветку через firstString и стирали связь, отвечая 200: клиент,
    // который шлёт `leadId: 0` вместо «не выбрано», получал бы стёртую связь
    // и запись в журнале как об осознанном действии оператора.
    if (typeof raw !== "string" && raw !== null && raw !== undefined) {
      throw new CrmReferenceValidationError([`${field.fieldName} must be a valid id`]);
    }
    const id = firstString(body[field.keys[0]], body[field.keys[1]]);
    if (!id) {
      row[field.column] = null;
      // Taking the task off a colleague clears the name with the id, or the
      // card would keep showing someone who is no longer responsible for it.
      if (field.column === "assignee_user_id") row.assignee_name = null;
      continue;
    }

    const isAssignee = field.column === "assignee_user_id";
    const reference = await readWorkspaceReference({
      supabase,
      workspaceId,
      table: field.table,
      id,
      select: isAssignee ? "id,full_name,status" : "id",
      fieldName: field.fieldName,
    });
    row[field.column] = reference.id;

    if (isAssignee) {
      // A deactivated colleague would leave the task in a queue nobody reads —
      // the same rule the lead's responsible person already follows.
      if (readString(reference.status).toLowerCase() !== "active") {
        throw new CrmReferenceValidationError(["assigneeUserId must be an active staff member"]);
      }
      row.assignee_name = readString(reference.full_name) || null;
    }
  }

  return row;
}

async function buildDealReferenceRow(
  supabase: CrmSupabaseClient,
  workspaceId: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  const row: JsonRecord = {};
  const referenceFields: Array<{
    keys: [string, string];
    column: string;
    table: "clients" | "leads" | "appointments" | "meta_campaign_launches" | "staff_users";
    fieldName: string;
  }> = [
    { keys: ["clientId", "client_id"], column: "client_id", table: "clients", fieldName: "clientId" },
    { keys: ["leadId", "lead_id"], column: "lead_id", table: "leads", fieldName: "leadId" },
    { keys: ["appointmentId", "appointment_id"], column: "appointment_id", table: "appointments", fieldName: "appointmentId" },
    { keys: ["metaCampaignLaunchId", "meta_campaign_launch_id"], column: "meta_campaign_launch_id", table: "meta_campaign_launches", fieldName: "metaCampaignLaunchId" },
    { keys: ["responsibleUserId", "responsible_user_id"], column: "responsible_user_id", table: "staff_users", fieldName: "responsibleUserId" },
  ];

  for (const field of referenceFields) {
    if (!hasAnyKey(body, field.keys)) continue;
    const id = firstString(body[field.keys[0]], body[field.keys[1]]);
    if (!id) {
      row[field.column] = null;
    } else {
      const reference = await readWorkspaceReference({
        supabase,
        workspaceId,
        table: field.table,
        id,
        select: "id",
        fieldName: field.fieldName,
      });
      row[field.column] = reference.id;
    }
  }

  return row;
}

/**
 * The patient this number already belongs to, asked of the database.
 *
 * Lead → client conversion used to answer this by reading every client of the
 * workspace and searching the array in the browser. Two ways that produced a
 * duplicate card: past whatever row cap PostgREST is configured with the
 * returning patient was simply not in the window, and the browser compared
 * digits only — so the trunk form «8 701…» and «+7 701…» were already two
 * different people at any clinic size.
 *
 * Both numbers are checked because a patient reached on WhatsApp at a second
 * number is still that patient. Two indexed equalities rather than one `.or()`:
 * PostgREST's or-filter is a string mini-language this codebase uses nowhere
 * else, and each of these hits its own partial index from migration 030.
 */
async function findClientsByPhone(
  supabase: CrmSupabaseClient,
  workspaceId: string,
  rawPhone: string,
): Promise<JsonRecord[]> {
  const canonical = normalizePhone(rawPhone);
  if (!canonical) return [];

  const config = configs.clients;
  const found: JsonRecord[] = [];
  const seen = new Set<string>();

  const collect = (data: unknown) => {
    for (const raw of Array.isArray(data) ? data : []) {
      const row = asRecord(raw);
      const id = readString(row.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      found.push(row);
    }
  };

  for (const column of ["phone_normalized", "whatsapp_normalized"]) {
    const { data, error } = await supabase
      .from(config.table)
      .select(config.selectColumns ?? "*")
      // Newest first, and stated rather than left to the plan. Without it
      // PostgREST returns whatever order the executor produced, and the caller
      // takes the first row — so a patient who already has two cards would be
      // attached to a different one after any update that moved a row. The
      // browser this replaced was deterministic by accident: it read the list
      // ordered by created_at and searched that.
      .order("created_at", { ascending: false })
      .eq("workspace_id", workspaceId)
      .eq(column, canonical)
      .limit(CLIENT_PHONE_MATCH_LIMIT);

    if (!error) {
      collect(data);
      continue;
    }

    // Only "the column is not there yet" may degrade. Everything else — a
    // timeout, a revoked grant, a dropped connection — is a failure, and
    // answering it with an empty list would say «this clinic has no such
    // patient» when the truth is unknown. That is the Security-2F rule this
    // file states二 lines below for the unfiltered read, and the rule
    // test:wazzup-webhook WZ22 pins for the identical lookup on leads.
    if (!isMissingColumn(error, column)) {
      throw new Error(`client lookup: ${error.message}`);
    }

    // Migration 030 is not applied yet. A deployment reaches production before
    // its migrations are applied by hand here, and without this the dedup
    // would not merely be unavailable in that window — it would be OFF, and
    // every conversion would file a second card for a returning patient,
    // including one whose number is spelled identically. Worse than the state
    // this branch replaced. So the comparison happens in code, on a bounded
    // read, exactly as lib/crm/inbound-whatsapp.ts does for leads.
    console.warn(`clients: ${column} not present yet, comparing in code until migration 030 is applied`);
    const { data: candidates, error: candidatesError } = await supabase
      .from(config.table)
      .select(config.selectColumns ?? "*")
      .order("created_at", { ascending: false })
      .eq("workspace_id", workspaceId)
      .limit(CLIENT_FALLBACK_SCAN_LIMIT);
    if (candidatesError) throw new Error(`client lookup: ${candidatesError.message}`);

    collect(
      (Array.isArray(candidates) ? candidates : [])
        .map((row) => asRecord(row))
        .filter((row) =>
          [normalizePhone(readString(row.phone)), normalizePhone(readString(row.whatsapp))].includes(canonical))
        .slice(0, CLIENT_PHONE_MATCH_LIMIT),
    );
    // Both columns are missing or present together, so one pass is enough.
    break;
  }

  return found;
}

/** Postgres "column does not exist" — the one error the fallback answers to. */
const UNDEFINED_COLUMN = "42703";

/** Колонки, которых нет в базе, пока не применена forward-миграция 031. */
const TASK_COLUMNS_FROM_031 = [
  "lead_id",
  "client_id",
  "appointment_id",
  "created_by_staff_user_id",
  "created_by_kind",
  "completed_at",
];

function isMissingAnyColumn(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  if (readString(error.code) === UNDEFINED_COLUMN) return true;
  return readString(error.message).toLowerCase().includes("does not exist");
}

/**
 * Строка без колонок, которых в базе может ещё не быть.
 *
 * Деплой доходит до production раньше, чем миграция применяется руками —
 * штатный порядок здесь. Первая версия этой ветки писала created_by_kind в
 * КАЖДОМ создании задачи, поэтому в этом окне ломалось не «связывание с
 * заявкой», а создание задачи вообще: PostgREST отвергал вставку по
 * неизвестной колонке, и обработчик отвечал 502. Ломалось то, что до ветки
 * работало, — и собственный документ ветки утверждал обратное.
 */
function taskRowWithout031(row: JsonRecord): { row: JsonRecord; dropped: string[] } {
  const stripped: JsonRecord = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (TASK_COLUMNS_FROM_031.includes(key)) {
      if (value !== null && value !== undefined) dropped.push(key);
      continue;
    }
    stripped[key] = value;
  }
  return { row: stripped, dropped };
}

function isMissingColumn(error: { code?: unknown; message?: unknown } | null, column: string): boolean {
  if (!error) return false;
  if (readString(error.code) === UNDEFINED_COLUMN) return true;
  const message = readString(error.message).toLowerCase();
  return message.includes(column) && message.includes("does not exist");
}

/**
 * The fallback's ceiling, and an honest one.
 *
 * This is the window before migration 030 is applied, and inside it the check
 * is only as good as the read: a clinic past this many clients can have the
 * existing card outside the window, which is the very defect 030 removes. It
 * is a bridge, not a design — it stops being used the moment the columns exist.
 */
const CLIENT_FALLBACK_SCAN_LIMIT = 1000;

/**
 * A handful is enough to decide. The question is "does this patient already
 * have a card", and a workspace with more than a few cards on one number has a
 * data problem the conversion screen is not the place to solve.
 */
const CLIENT_PHONE_MATCH_LIMIT = 5;

async function listItems(resource: CrmResource, req: VercelRequest, res: VercelResponse) {
  const config = configs[resource];
  const workspaceId = readWorkspaceId(req, {});
  // Security-2B: the ?email= lookup is gone. It answered for any address in any
  // workspace and was how a caller discovered workspace_id, role and status.
  // The current user is identified by the verified JWT via /api/crm/auth-context.
  const supabase = getSupabaseServerClient();

  if (!supabase || !isUuid(workspaceId)) {
    return sendJson(
      res,
      200,
      success("demo", { [config.listKey]: [], items: [] }, !supabase ? "Supabase env is not configured" : "Demo workspace uses localStorage"),
    );
  }

  try {
    // A caller asking «does this number already have a card» gets exactly that,
    // instead of the whole clinic to search in the browser. The filter is a
    // narrowing of the same authorized read — same route, same view_clients
    // permission, same workspace scope — so it opens nothing new.
    if (resource === "clients") {
      const phone = readQueryString(req.query.phone);
      if (phone) {
        const rows = await findClientsByPhone(supabase, workspaceId, phone);
        const matches = rows.map((row) => config.fromRow(row));
        return sendJson(res, 200, success("supabase", { [config.listKey]: matches, items: matches }));
      }
    }

    // Параметры разбираются ДО того, как построен запрос: мусор в фильтре
    // отвергается, не коснувшись базы. Обратный порядок работал бы так же с
    // точки зрения ответа, но заводил бы обращение к таблице ради заведомо
    // невалидного запроса — и тест это заметил.
    const equalities: Array<[string, string]> = [];
    let dueBefore: string | null = null;

    if (resource === "tasks") {
      for (const [param, column] of [
        ["assigneeUserId", "assignee_user_id"],
        ["leadId", "lead_id"],
        ["clientId", "client_id"],
        ["appointmentId", "appointment_id"],
      ] as const) {
        const value = readQueryString(req.query[param]);
        if (!value) continue;
        if (!isUuid(value)) {
          return sendJson(res, 400, errorBody("Validation error", [`${param} must be a valid id`]));
        }
        equalities.push([column, value]);
      }

      const status = readQueryString(req.query.status);
      if (status) {
        const canonical = canonicalTaskStatus(status);
        if (!canonical) {
          // Соседние параметры при мусоре отвечают 400 и до базы не доходят.
          // Прежняя версия отдавала 200 со списком НОВЫХ задач: вызывающая
          // сторона не могла отличить «таких задач нет» от «такого статуса нет».
          return sendJson(res, 400, errorBody("Validation error", ["status must be one of: new, in_progress, done"]));
        }
        equalities.push(["status", canonical]);
      }

      const rawDueBefore = readQueryString(req.query.dueBefore ?? req.query.due_before);
      if (rawDueBefore) {
        dueBefore = maybeDate(rawDueBefore);
        if (!dueBefore) {
          return sendJson(res, 400, errorBody("Validation error", ["dueBefore must be a valid date"]));
        }
      }
    }

    let query = supabase
      .from(config.table)
      .select(config.selectColumns ?? "*")
      .order(config.sortableColumn, { ascending: config.sortableAscending ?? false });

    query = query.eq("workspace_id", workspaceId);

    // Задачи спрашивают узко: что открыто у меня, что просрочено, что висит на
    // этой заявке. Отдать весь workspace и отфильтровать в браузере — это тот
    // самый механизм, которым список превращается в свалку ровно тогда, когда
    // PostgREST молча обрежет выдачу. Сужение того же авторизованного чтения,
    // как у clients?phone: тот же маршрут, то же право, тот же скоуп.
    for (const [column, value] of equalities) query = query.eq(column, value);
    if (dueBefore) query = query.lt("due_at", dueBefore);

    const { data, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    const items = (Array.isArray(data) ? data : []).map((row) => config.fromRow(asRecord(row)));
    return sendJson(res, 200, success("supabase", { [config.listKey]: items, items }));
  } catch (error) {
    // Security-2F: an empty list is an answer, and it was the wrong one — a
    // failed read looked exactly like a clinic with no records.
    return sendJson(
      res,
      502,
      errorBody("Не удалось загрузить данные", [redactedDetail(config.table, error, SERVICE_FAILURE_DETAIL)]),
    );
  }
}

async function createStaffItem(req: VercelRequest, res: VercelResponse) {
  const config = configs.staff;
  const rawBody = asRecord(req.body);
  const name = firstString(rawBody.name, rawBody.full_name, rawBody.fullName);
  const email = readString(rawBody.email).toLowerCase();
  const role = readString(rawBody.role) || "receptionist";
  const temporaryPassword = readString(rawBody.temporaryPassword) || generateTemporaryPassword();
  const body = {
    ...rawBody,
    name,
    email,
    role,
    temporaryPasswordSet: false,
    passwordResetRequired: false,
  };
  const details = [...validationDetails(body, config.requiredPost), ...resourceValidationDetails("staff", body)];

  if (details.length > 0) {
    return sendJson(res, 400, errorBody("Validation error", details));
  }

  const workspaceId = readWorkspaceId(req, body);
  const supabase = getSupabaseServerClient();
  const demoItem = config.demoItem({
    ...body,
    workspaceId,
    temporaryPasswordSet: true,
    passwordResetRequired: true,
    invitedAt: new Date().toISOString(),
  });

  if (!supabase || !isUuid(workspaceId)) {
    return sendJson(
      res,
      200,
      success(
        "demo",
        {
          item: demoItem,
          staff: demoItem,
          temporaryPassword,
          loginUrl: "/login",
          authUserCreated: false,
        },
        !supabase ? "Supabase env is not configured" : "Demo workspace uses localStorage",
      ),
    );
  }

  let authUserId = "";
  let authWarning = "";

  try {
    const authResult = await createSupabaseAuthUser({
      supabase,
      email,
      password: temporaryPassword,
      name,
      role,
      workspaceId,
    });
    authUserId = authResult.authUserId;
    authWarning = authResult.warning || "";
  } catch (error) {
    authWarning = error instanceof Error ? error.message : "Supabase Auth user was not created";
  }

  try {
    const row = config.toRow(
      {
        ...body,
        authUserId,
        temporaryPasswordSet: Boolean(authUserId),
        invitedAt: new Date().toISOString(),
        passwordResetRequired: Boolean(authUserId),
      },
      workspaceId,
    );
    const { data, error } = await supabase.from(config.table).insert(row).select("*").single();

    if (error) {
      throw new Error(error.message);
    }

    const item = config.fromRow(asRecord(data));
    const warning = authWarning
      ? `Сотрудник создан как профиль, но auth user не создан: ${authWarning}`
      : undefined;

    return sendJson(
      res,
      201,
      success(
        "supabase",
        {
          item,
          staff: item,
          ...(authUserId ? { temporaryPassword } : {}),
          loginUrl: "/login",
          authUserCreated: Boolean(authUserId),
        },
        warning,
      ),
    );
  } catch (error) {
    const warning = supabaseWarning(config.table, error);
    console.warn(warning);
    return sendJson(
      res,
      200,
      success(
        "demo",
        {
          item: demoItem,
          staff: demoItem,
          temporaryPassword,
          loginUrl: "/login",
          authUserCreated: false,
        },
        warning,
      ),
    );
  }
}

async function createItem(resource: CrmResource, req: VercelRequest, res: VercelResponse) {
  if (resource === "staff") {
    return createStaffItem(req, res);
  }

  const config = configs[resource];
  const body = asRecord(req.body);
  const details = [...validationDetails(body, config.requiredPost), ...resourceValidationDetails(resource, body)];

  if (details.length > 0) {
    return sendJson(res, 400, errorBody("Validation error", details));
  }

  const workspaceId = readWorkspaceId(req, body);
  const demoItem = config.demoItem(body);
  const supabase = getSupabaseServerClient();

  if (!supabase || !isUuid(workspaceId)) {
    return sendJson(
      res,
      200,
      success("demo", { [resource === "content-videos" ? "video" : "item"]: demoItem, item: demoItem }, !supabase ? "Supabase env is not configured" : "Demo workspace uses localStorage"),
    );
  }

  try {
    const row = config.toRow(body, workspaceId);
    if (resource === "leads") {
      Object.assign(row, await buildLeadReferenceRow(supabase, workspaceId, body));
    }
    if (resource === "deals") {
      Object.assign(row, await buildDealReferenceRow(supabase, workspaceId, body));
    }
    if (resource === "tasks") {
      Object.assign(row, await buildTaskReferenceRow(supabase, workspaceId, body));
      // Кто поставил задачу — из проверенного контекста, не из тела. Вид автора
      // берёт словарь журнала изменений: продукт уже обещает задачи, которые
      // ставит не человек, и список, где автосозданный follow-up неотличим от
      // поручения заведующей, перестают читать.
      const author = journalActor(req);
      if (isUuid(author.actorStaffUserId)) row.created_by_staff_user_id = author.actorStaffUserId;
      row.created_by_kind = author.actorKind;
      if (readString(row.status) === "done") row.completed_at = new Date().toISOString();
    }
    if (resource === "appointments") {
      Object.assign(row, await buildAppointmentReferenceRow(supabase, workspaceId, body));
      if (!allowsAppointmentConflict(body)) {
        await assertNoAppointmentConflict(supabase, workspaceId, {
          doctorName: readString(row.doctor_name),
          startsAt: readString(row.starts_at),
          durationMinutes: appointmentMinutes(row.duration_minutes),
          status: readString(row.status),
        });
      }
    }
    const runInsert = (candidate: JsonRecord) => (config.upsertConflict
      ? supabase.from(config.table).upsert(candidate, { onConflict: config.upsertConflict }).select(config.selectColumns ?? "*").single()
      : supabase.from(config.table).insert(candidate).select(config.selectColumns ?? "*").single());

    let { data, error } = await runInsert(row);

    // Пока 031 не применена, колонок связи и авторства в базе нет. Отказать
    // в создании задачи целиком — хуже, чем создать её без связи: до этой
    // ветки задачи создавались, и окно между деплоем и миграцией не повод
    // это отнимать. Тот же приём, которым закрыт поиск клиента по телефону.
    if (error && resource === "tasks" && isMissingAnyColumn(error)) {
      const fallback = taskRowWithout031(row);
      console.warn(
        `tasks: columns from migration 031 are not present yet (${fallback.dropped.join(", ") || "none set"}); `
          + "creating without them",
      );
      ({ data, error } = await runInsert(fallback.row));
    }

    if (error) {
      throw new Error(error.message);
    }

    const item = config.fromRow(asRecord(data));

    // Журнал пишется ПОСЛЕ доменной записи и только на успехе. Порядок здесь
    // не стилистический: тесты изоляции ищут первую вставку в журнале запросов
    // без указания таблицы, и строка журнала впереди подменила бы им предмет
    // проверки. А запись на отказанной мутации сломала бы восемь проверок
    // «ни одного запроса к данным», которые и есть доказательство отказа.
    const createdEntity = journaledEntityFor(resource);
    if (createdEntity) {
      const stored = asRecord(data);
      await recordCrmChange({
        supabase,
        workspaceId,
        entity: createdEntity,
        entityId: readString(stored.id),
        action: "created",
        changes: diffForJournal(createdEntity, {}, stored),
        ...journalActor(req),
      });

      // Обоснование гейта — «перезапись стала решением, которое кто-то принял».
      // Решение без следа таковым не является: владелец не смог бы ни отличить
      // сознательную перезапись от рядовой брони, ни узнать, кто её
      // санкционировал. Отдельная строка журнала — и есть этот след.
      if (resource === "appointments" && allowsAppointmentConflict(body)) {
        await recordCrmChange({
          supabase,
          workspaceId,
          entity: "appointment",
          entityId: readString(stored.id),
          action: "overbooked",
          changes: [],
          ...journalActor(req),
        });
      }
    }

    return sendJson(res, 201, success("supabase", { [resource === "content-videos" ? "video" : "item"]: item, item }));
  } catch (error) {
    if (error instanceof AppointmentConflictError) {
      return sendJson(res, 409, {
        success: false,
        error: "Это время у врача уже занято",
        code: "appointment_conflict",
        conflict: error.conflict,
      });
    }
    if (error instanceof CrmReferenceValidationError) {
      return sendJson(res, 400, errorBody(error.message, error.details));
    }
    // Security-2F: a write the database refused is not a success. This answered
    // 200 with a demo item and a warning, which the browser dropped on the
    // floor — the operator saw the record appear in the list and it was gone on
    // the next load. Demo mode is unaffected: it is chosen before the query,
    // not after it fails.
    return sendJson(
      res,
      502,
      errorBody("Не удалось сохранить запись", [redactedDetail(config.table, error, SERVICE_FAILURE_DETAIL)]),
    );
  }
}

/**
 * Security-2B staff update rules. The actor is the verified context; the target
 * row must already have been fetched inside the acting workspace.
 */
function staffPatchRejection(
  context: WorkspaceAccessContext,
  targetRole: string,
  targetStaffUserId: string,
  requestedRole: string,
): { status: number; message: string; code: string } | null {
  const actorRole = context.role;

  // Only owners may touch an owner row. An admin must not demote, rename or
  // deactivate the account that can restore everything else.
  if (targetRole === "owner" && actorRole !== "owner") {
    return { status: 403, message: "Insufficient permissions", code: "permission_denied" };
  }

  if (!requestedRole) return null;

  if (!isStaffRole(requestedRole)) {
    return { status: 400, message: "Validation error", code: "invalid_role" };
  }

  // Self-promotion through the request body was the escalation Commercial-3A
  // found; an actor may never change its own role here.
  if (targetStaffUserId && targetStaffUserId === context.staffUserId) {
    return { status: 403, message: "Insufficient permissions", code: "permission_denied" };
  }

  // owner is never assignable through the generic endpoint, and no actor may
  // grant a role at or above its own rank.
  if (!canAssignRole(actorRole, requestedRole)) {
    return { status: 403, message: "Insufficient permissions", code: "permission_denied" };
  }

  return null;
}

async function patchItem(resource: CrmResource, req: VercelRequest, res: VercelResponse) {
  const config = configs[resource];
  const body = asRecord(req.body);
  const updates = asRecord(body.updates);
  const patchBody = Object.keys(updates).length > 0 ? updates : body;
  const id = firstString(body.id, patchBody.id, readQueryString(req.query.id));

  if (!id) {
    return sendJson(res, 400, {
      ...errorBody("PATCH failed", ["id is required"]),
      resource,
    });
  }

  const details = validationDetails(patchBody, config.requiredPatch ?? []);
  if (details.length > 0) {
    return sendJson(res, 400, {
      ...errorBody("PATCH failed", details),
      resource,
    });
  }

  const workspaceId = readWorkspaceId(req, body);
  const demoItem = config.demoItem({ ...patchBody, id, workspaceId });
  const supabase = getSupabaseServerClient();

  if (!supabase || !isUuid(workspaceId) || !isUuid(id)) {
    return sendJson(
      res,
      200,
      success("demo", { [resource === "content-videos" ? "video" : "item"]: demoItem, item: demoItem }, !supabase ? "Supabase env is not configured" : "Demo workspace uses localStorage"),
    );
  }

  try {
    if (resource === "staff") {
      const context = readWorkspaceContext(req);
      if (!context) {
        return sendJson(res, 403, { success: false, error: "Access denied", code: "workspace_access_denied" });
      }

      // Read the target inside the acting workspace. A foreign or missing id is
      // reported identically so membership in another clinic never leaks.
      const { data: targetData, error: targetError } = await supabase
        .from("staff_users")
        .select("id, role, status")
        .eq("id", id)
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      if (targetError || !targetData) {
        return sendJson(res, 404, { success: false, error: "Resource not found", code: "resource_not_found" });
      }

      const target = asRecord(targetData);
      const targetRole = readString(target.role).toLowerCase();
      const requestedRole = readString(patchBody.role).toLowerCase();
      const rejection = staffPatchRejection(context, targetRole, readString(target.id), requestedRole);
      if (rejection) {
        return sendJson(res, rejection.status, {
          success: false,
          error: rejection.message,
          code: rejection.code,
        });
      }

      // Last-owner protection. The generic endpoint refuses any change that
      // could remove the final active owner; a safe atomic flow for that belongs
      // to a dedicated ownership-transfer path, not to a field update.
      if (targetRole === "owner") {
        const demoting = Boolean(requestedRole) && requestedRole !== "owner";
        const deactivating = readString(patchBody.status).toLowerCase() === "inactive";
        if (demoting || deactivating) {
          const { count, error: countError } = await supabase
            .from("staff_users")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", workspaceId)
            .eq("role", "owner")
            .eq("status", "active");
          if (countError || (count ?? 0) <= 1) {
            return sendJson(res, 409, {
              success: false,
              error: "The last active owner cannot be removed",
              code: "last_owner_protected",
            });
          }
        }
      }
    }

    const row = buildPatchRow(resource, patchBody);
    if (resource === "leads") {
      Object.assign(row, await buildLeadReferenceRow(supabase, workspaceId, patchBody));
    }
    if (resource === "deals") {
      Object.assign(row, await buildDealReferenceRow(supabase, workspaceId, patchBody));
    }
    if (resource === "tasks") {
      Object.assign(row, await buildTaskReferenceRow(supabase, workspaceId, patchBody));

      // Свободный текст исполнителя правят старым путём, не трогая ссылку.
      // Тогда карточка показывает одно имя, а «мои задачи» по ссылке относят
      // задачу другому: имя перестаёт быть снимком того, на кого назначено.
      // Правка имени без ссылки снимает ссылку — имя снова просто текст.
      if ("assignee_name" in row && !("assignee_user_id" in row)) {
        row.assignee_user_id = null;
      }
    }
    if (resource === "appointments") {
      Object.assign(row, await buildAppointmentReferenceRow(supabase, workspaceId, patchBody));
    }

    if (Object.keys(row).length === 0) {
      return sendJson(res, 200, success("supabase", { [resource === "content-videos" ? "video" : "item"]: demoItem, item: demoItem }));
    }

    // «Было» приходится читать отдельно: PostgREST возвращает строку после
    // записи, а не до, и полного пред-чтения в этом проекте не было нигде.
    // Один лишний запрос — и только на журналируемых ресурсах, и только на
    // записи, которая и так редка по сравнению с чтением.
    const patchedEntity = journaledEntityFor(resource);
    const before = patchedEntity
      ? await readRowBeforeChange(supabase, config.table, workspaceId, id)
      : {};

    if (patchedEntity === "task" && typeof row.status === "string") {
      // Время закрытия двигает ПЕРЕХОД, а не присутствие ключа в теле. Форма
      // редактирования шлёт объект целиком, включая неизменившийся статус, —
      // прежняя версия сдвигала бы дату закрытия на «сейчас» при каждом
      // сохранении, роняя давно закрытую задачу в отчёт «сделано сегодня» и
      // порождая ложную строку «Закрыта: понедельник → пятница» в истории.
      // `before` уже прочитан для журнала, второго запроса это не стоит.
      const wasDone = readString(before.status) === "done";
      const isDone = row.status === "done";
      if (isDone && !wasDone) row.completed_at = new Date().toISOString();
      else if (!isDone && wasDone) row.completed_at = null;
    }

    if (patchedEntity === "appointment" && !allowsAppointmentConflict(patchBody)) {
      // Проверять надо по СЛИЯНИЮ: патч может нести только новое время, только
      // нового врача или только статус, а занимает слот их сочетание. `before`
      // уже прочитан для журнала — второго запроса это не стоит.
      //
      // «Есть в патче», а не `??`: buildPatchRow кодирует «очистить поле» тем же
      // null, что и «поля нет», поэтому `??` судил снятие врача по прежнему
      // врачу и отказывал в правке, которая ничей слот бы не заняла.
      const merged = {
        doctorName: readString("doctor_name" in row ? row.doctor_name : before.doctor_name),
        startsAt: readString("starts_at" in row ? row.starts_at : before.starts_at),
        durationMinutes: appointmentMinutes("duration_minutes" in row ? row.duration_minutes : before.duration_minutes),
        status: readString("status" in row ? row.status : before.status),
      };

      // И только если правка действительно ДВИГАЕТ запись или ОЖИВЛЯЕТ её.
      //
      // Первая версия проверяла любой PATCH — и этим ломала будни клиники,
      // которые сама же и создала. Регистратор сознательно ставит срочный
      // случай поверх занятого часа («Сохранить всё равно», это разрешено);
      // пациент приходит, регистратор жмёт «Пришёл» — и ловит 409 от соседней
      // записи, у которой на карточке нет кнопки обхода. Кнопки «Подтвердить»
      // и «Пришёл» переставали работать навсегда на обеих записях. Тем же
      // ударом накрывало всю уже существующую историю production, которая
      // никогда этой проверки не проходила.
      //
      // Запись, которая остаётся на своём месте в своём статусе, не занимает
      // ничего нового — судить её повторно не за что.
      const moved = ["doctor_name", "starts_at", "duration_minutes"].some(
        (column) => column in row && readString(row[column]) !== readString(before[column]),
      );
      const revived = "status" in row
        && occupiesSlot(merged.status)
        && !occupiesSlot(readString(before.status));

      if (moved || revived) {
        await assertNoAppointmentConflict(supabase, workspaceId, { id, ...merged });
      }
    }

    const runUpdate = (candidate: JsonRecord) => supabase
      .from(config.table)
      .update(candidate)
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .select(config.selectColumns ?? "*")
      .single();

    let { data, error } = await runUpdate(row);

    if (error && resource === "tasks" && isMissingAnyColumn(error)) {
      const fallback = taskRowWithout031(row);
      console.warn(
        `tasks: columns from migration 031 are not present yet (${fallback.dropped.join(", ") || "none set"}); `
          + "saving without them",
      );
      ({ data, error } = await runUpdate(fallback.row));
    }

    if (error) {
      throw new Error(error.message);
    }

    const item = config.fromRow(asRecord(data));

    if (patchedEntity) {
      // Сравнивается с `row`, а не с сохранённой строкой: в `row` лежит ровно
      // то, чего коснулась правка, поэтому поле, которого патч не касался, не
      // попадёт в ленту даже как «не изменилось».
      await recordCrmChange({
        supabase,
        workspaceId,
        entity: patchedEntity,
        entityId: id,
        action: "updated",
        changes: diffForJournal(patchedEntity, before, row),
        ...journalActor(req),
      });
    }

    return sendJson(res, 200, success("supabase", { [resource === "content-videos" ? "video" : "item"]: item, item }));
  } catch (error) {
    if (error instanceof AppointmentConflictError) {
      return sendJson(res, 409, {
        success: false,
        error: "Это время у врача уже занято",
        code: "appointment_conflict",
        conflict: error.conflict,
      });
    }
    if (error instanceof CrmReferenceValidationError) {
      return sendJson(res, 400, errorBody(error.message, error.details));
    }
    // Security-2F: a write the database refused is not a success. This answered
    // 200 with a demo item and a warning, which the browser dropped on the
    // floor — the operator saw the record appear in the list and it was gone on
    // the next load. Demo mode is unaffected: it is chosen before the query,
    // not after it fails.
    return sendJson(
      res,
      502,
      errorBody("Не удалось сохранить запись", [redactedDetail(config.table, error, SERVICE_FAILURE_DETAIL)]),
    );
  }
}

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

// Large video optimization pipeline (Phase A). Raw originals are temporary:
// they live in a private bucket and are never sent to Meta or end users.
const DEFAULT_RAW_VIDEO_BUCKET = "ad-creatives-raw";
// The one bucket a browser-initiated creative upload may ever reach. It is
// public by design (migration 015) because Meta fetches creatives by URL.
const AD_CREATIVE_BUCKET = "ad-creatives";
const VIDEO_JOB_STATUSES = new Set(["awaiting_upload", "queued", "downloading", "transcoding", "uploading", "ready", "failed", "deleted_original"]);
export const VIDEO_OPTIMIZATION_DISABLED_MESSAGE =
  "Оптимизация больших видео отключена. Загрузите MP4 до 100 MB или включите VIDEO_OPTIMIZATION_ENABLED в Vercel.";

function readPositiveNumberEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]?.trim() ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function videoOptimizationConfig(): {
  enabled: boolean;
  thresholdMb: number;
  maxInputMb: number;
  rawBucket: string;
  workerSecretConfigured: boolean;
} {
  return {
    enabled: ["true", "1", "yes", "on"].includes(String(process.env.VIDEO_OPTIMIZATION_ENABLED || "").trim().toLowerCase()),
    thresholdMb: readPositiveNumberEnv("VIDEO_OPTIMIZATION_THRESHOLD_MB", 50),
    maxInputMb: readPositiveNumberEnv("VIDEO_OPTIMIZATION_MAX_INPUT_MB", 500),
    rawBucket: firstString(process.env.VIDEO_OPTIMIZATION_RAW_BUCKET, DEFAULT_RAW_VIDEO_BUCKET),
    workerSecretConfigured: Boolean(firstString(process.env.VIDEO_OPTIMIZATION_WORKER_SECRET)),
  };
}

// Safe job shape for the UI: no raw paths/bucket internals, no worker claim data.
function makeVideoJob(body: JsonRecord): JsonRecord {
  const statusRaw = readString(body.status).toLowerCase();
  const inputSizeBytes = readNumber(body.inputSizeBytes ?? body.input_size_bytes ?? body.rawSize ?? body.raw_size) ?? null;
  const outputSizeBytes = readNumber(body.outputSizeBytes ?? body.output_size_bytes ?? body.optimizedSizeBytes ?? body.optimized_size_bytes ?? body.outputSize ?? body.output_size) ?? null;
  return {
    id: readString(body.id) || nextDemoId("video-job"),
    workspaceId: firstString(body.workspaceId, body.workspace_id),
    assetId: firstString(body.assetId, body.asset_id),
    status: VIDEO_JOB_STATUSES.has(statusRaw) ? statusRaw : "awaiting_upload",
    progress: readNumber(body.progress) ?? 0,
    sourceFileName: firstString(body.sourceFileName, body.source_file_name),
    sourceMimeType: firstString(body.sourceMimeType, body.source_mime_type, body.inputMimeType, body.input_mime_type),
    inputMimeType: firstString(body.inputMimeType, body.input_mime_type, body.sourceMimeType, body.source_mime_type),
    outputMimeType: firstString(body.outputMimeType, body.output_mime_type),
    rawSize: inputSizeBytes,
    inputSizeBytes,
    outputPublicUrl: firstString(body.outputPublicUrl, body.output_public_url, body.optimizedPublicUrl, body.optimized_public_url),
    optimizedPublicUrl: firstString(body.optimizedPublicUrl, body.optimized_public_url, body.outputPublicUrl, body.output_public_url),
    outputSize: outputSizeBytes,
    outputSizeBytes,
    thumbnailPublicUrl: firstString(body.thumbnailPublicUrl, body.thumbnail_public_url, body.thumbnailUrl, body.thumbnail_url),
    thumbnailUrl: firstString(body.thumbnailUrl, body.thumbnail_url, body.thumbnailPublicUrl, body.thumbnail_public_url),
    thumbnailSource: firstString(body.thumbnailSource, body.thumbnail_source),
    compressionRatio: readNumber(body.compressionRatio ?? body.compression_ratio) ?? null,
    metaVideoId: firstString(body.metaVideoId, body.meta_video_id),
    error: firstString(body.error, body.errorMessage, body.error_message),
    errorMessage: firstString(body.errorMessage, body.error_message, body.error),
    attempts: readNumber(body.attempts) ?? 0,
    rawDeletedAt: firstString(body.rawDeletedAt, body.raw_deleted_at) || null,
    startedAt: firstString(body.startedAt, body.started_at) || null,
    completedAt: firstString(body.completedAt, body.completed_at) || null,
    createdAt: firstString(body.createdAt, body.created_at, new Date().toISOString()),
    updatedAt: firstString(body.updatedAt, body.updated_at, new Date().toISOString()),
  };
}

function fileExtension(fileName: string): string {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

function getHeaderValue(req: VercelRequest, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function isMultipartRequest(req: VercelRequest): boolean {
  return getHeaderValue(req, "content-type").toLowerCase().includes("multipart/form-data");
}

function readMultipartBoundary(contentType: string): string {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] || match?.[2] || "").trim();
}

async function readRequestBuffer(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function parseHeaderParams(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const segment of value.split(";").map((item) => item.trim()).filter(Boolean)) {
    const [rawKey, ...rawValue] = segment.split("=");
    const key = rawKey.trim().toLowerCase();
    const text = rawValue.join("=").trim();
    if (!text) continue;
    params[key] = text.replace(/^"|"$/g, "");
  }

  return params;
}

function parseMultipartFormData(buffer: Buffer, contentType: string): MultipartFormData {
  const boundary = readMultipartBoundary(contentType);
  if (!boundary) {
    throw new Error("multipart boundary is missing");
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const fields: JsonRecord = {};
  let file: MultipartFile | undefined;
  let cursor = buffer.indexOf(delimiter);

  while (cursor >= 0) {
    cursor += delimiter.length;
    const closing = buffer.subarray(cursor, cursor + 2).toString("utf8") === "--";
    if (closing) break;
    if (buffer.subarray(cursor, cursor + 2).toString("utf8") === "\r\n") cursor += 2;

    const next = buffer.indexOf(delimiter, cursor);
    if (next < 0) break;

    let part = buffer.subarray(cursor, next);
    if (part.subarray(part.length - 2).toString("utf8") === "\r\n") {
      part = part.subarray(0, part.length - 2);
    }

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd >= 0) {
      const rawHeaders = part.subarray(0, headerEnd).toString("utf8");
      const body = part.subarray(headerEnd + 4);
      const headers: Record<string, string> = {};

      for (const line of rawHeaders.split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
      }

      const disposition = headers["content-disposition"] || "";
      const params = parseHeaderParams(disposition);
      const fieldName = params.name || "";
      const fileName = params.filename || "";

      if (fieldName && fileName && !file) {
        file = {
          fieldName,
          fileName,
          mimeType: headers["content-type"] || "application/octet-stream",
          buffer: body,
        };
      } else if (fieldName) {
        fields[fieldName] = body.toString("utf8");
      }
    }

    cursor = next;
  }

  return { fields, file };
}

function safeStorageFileName(name: string): string {
  const extension = fileExtension(name) || "bin";
  const base = name
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9-_]+/gi, "-")
    .slice(0, 42) || "creative";
  return `${base}.${extension}`;
}

function safeStoragePathSegment(value: string, fallback: string): string {
  return value
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function randomStorageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function buildAdCreativeStoragePath(input: { workspaceId: string; fileName: string }): string {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const workspace = safeStoragePathSegment(input.workspaceId || DEMO_WORKSPACE_ID, DEMO_WORKSPACE_ID);
  return `${workspace}/${year}/${month}/${randomStorageId()}-${safeStorageFileName(input.fileName)}`;
}

/**
 * Storage-1: an object key that arrives from a browser must live under the
 * caller's own workspace prefix.
 *
 * The video worker reads `raw_path` off the job row with the service-role
 * client, publishes the transcoded result to the public bucket, and then
 * deletes the original. An arbitrary key therefore let a member of one
 * workspace have another workspace's private raw video republished publicly
 * and then removed. `buildAdCreativeStoragePath` is the only legitimate
 * producer of these keys and always starts them with the workspace segment,
 * so the check costs a legitimate caller nothing.
 *
 * Demo mode has no workspace of its own and never reaches the worker: without
 * a UUID there is nothing to compare against, and the handler already refuses
 * to persist.
 */
function isOwnWorkspaceStoragePath(storagePath: string, workspaceId: string): boolean {
  if (!isUuid(workspaceId)) return true;
  return storagePath.startsWith(`${safeStoragePathSegment(workspaceId, DEMO_WORKSPACE_ID)}/`);
}

function inferMimeType(input: { fileName: string; mimeType?: string }): string {
  const mimeType = firstString(input.mimeType);
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;

  const extension = fileExtension(input.fileName);
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "mp4") return "video/mp4";
  if (extension === "mov") return "video/quicktime";
  if (extension === "webm") return "video/webm";
  return mimeType || "application/octet-stream";
}

function validateSignedUploadBody(body: JsonRecord): { details: string[]; normalized: JsonRecord } {
  const fileName = firstString(body.fileName, body.file_name);
  const mimeType = inferMimeType({ fileName, mimeType: firstString(body.mimeType, body.mime_type) });
  const fileType = normalizeCreativeFileType({ ...body, fileName, mimeType });
  const fileSize = readNumber(body.fileSize ?? body.file_size) ?? 0;
  const details: string[] = [];

  if (!fileName) details.push("fileName is required");
  if (fileType === "image" && !IMAGE_MIME_TYPES.has(mimeType)) {
    details.push("Формат не поддерживается. Используйте JPG, PNG, WEBP, MP4, MOV или WEBM.");
  }
  if (fileType === "video" && !VIDEO_MIME_TYPES.has(mimeType)) {
    details.push("Формат не поддерживается. Используйте JPG, PNG, WEBP, MP4, MOV или WEBM.");
  }
  if (fileType === "image" && fileSize > MAX_IMAGE_BYTES) {
    details.push("Фото больше 10 MB. Сожмите изображение.");
  }
  if (fileType === "video" && fileSize > MAX_VIDEO_BYTES) {
    details.push("Видео больше 100 MB. Загрузите файл меньшего размера.");
  }
  if (fileSize <= 0) details.push("fileSize is required");

  return {
    details,
    normalized: {
      fileName,
      fileType,
      mimeType,
      fileSize,
    },
  };
}

function validateCreativeAssetBody(body: JsonRecord): string[] {
  const details: string[] = [];
  const fileName = firstString(body.fileName, body.file_name);
  const mimeType = firstString(body.mimeType, body.mime_type).toLowerCase();
  const fileSize = readNumber(body.fileSize ?? body.file_size) ?? 0;
  const fileType = normalizeCreativeFileType(body);
  const extension = fileExtension(fileName);

  if (!fileName) details.push("fileName is required");
  if (fileType === "image") {
    if (mimeType && !IMAGE_MIME_TYPES.has(mimeType)) details.push("Поддерживаются только изображения JPG, PNG или WEBP");
    if (!mimeType && extension && !IMAGE_EXTENSIONS.has(extension)) details.push("Поддерживаются только изображения JPG, PNG или WEBP");
    if (fileSize > MAX_IMAGE_BYTES) details.push("Фото должно быть не больше 10 МБ");
  }

  if (fileType === "video") {
    if (mimeType && !VIDEO_MIME_TYPES.has(mimeType)) details.push("Поддерживаются только видео MP4, MOV или WEBM");
    if (!mimeType && extension && !VIDEO_EXTENSIONS.has(extension)) details.push("Поддерживаются только видео MP4, MOV или WEBM");
    if (fileSize > MAX_VIDEO_BYTES) details.push("Видео должно быть не больше 100 МБ");
  }

  return details;
}

async function persistAdCreativeAsset(input: { workspaceId: string; body: JsonRecord }) {
  const config = configs["ad-creatives"];
  const supabase = getSupabaseServerClient();
  const demoItem = config.demoItem({ ...input.body, workspaceId: input.workspaceId });

  if (!supabase || !isUuid(input.workspaceId)) {
    return {
      mode: "demo" as CrmMode,
      asset: demoItem,
      warning: !supabase ? "Supabase env is not configured" : "Demo workspace uses localStorage",
    };
  }

  try {
    const row = config.toRow(input.body, input.workspaceId);
    const { data, error } = await supabase.from(config.table).insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return { mode: "supabase" as CrmMode, asset: config.fromRow(asRecord(data)), warning: "" };
  } catch (error) {
    const warning = supabaseWarning(config.table, error);
    console.warn(warning);
    return { mode: "demo" as CrmMode, asset: demoItem, warning };
  }
}

async function updateAdCreativeMeta(input: {
  workspaceId: string;
  assetId: string;
  metaVideoId?: string;
  metaAssetId?: string;
  status: string;
  metadata?: JsonRecord;
}) {
  const supabase = getSupabaseServerClient();
  if (!supabase || !isUuid(input.workspaceId) || !isUuid(input.assetId)) return;

  try {
    const { error } = await supabase
      .from("ad_creative_assets")
      .update({
        meta_video_id: input.metaVideoId || null,
        meta_asset_id: input.metaAssetId || null,
        status: input.status,
        metadata: input.metadata || {},
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.assetId)
      .eq("workspace_id", input.workspaceId);
    if (error) throw new Error(error.message);
  } catch (error) {
    console.warn(supabaseWarning("ad_creative_assets meta update", error));
  }
}

export async function handleAdCreativeSignedUpload(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use POST"]));
  }

  const body = asRecord(req.body);
  const { details, normalized } = validateSignedUploadBody(body);
  if (details.length > 0) {
    return sendJson(res, 400, errorBody("Validation error", details));
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(
      res,
      503,
      errorBody("Supabase Storage is not configured", [
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to create a signed upload URL.",
      ]),
    );
  }

  const bucket = AD_CREATIVE_BUCKET;
  const workspaceId = readWorkspaceId(req, body);
  const storagePath = buildAdCreativeStoragePath({
    workspaceId,
    fileName: firstString(normalized.fileName),
  });

  const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(storagePath);
  if (error) {
    return sendJson(
      res,
      502,
      errorBody("Signed upload URL failed", [
        redactedDetail("ad-creatives signed upload", error, SERVICE_FAILURE_DETAIL),
      ]),
    );
  }

  const signedData = asRecord(data);
  const signedUrl = firstString(signedData.signedUrl, signedData.signedURL, signedData.url);
  const token = firstString(signedData.token);
  const publicUrl = buildSupabaseStoragePublicUrl({ bucket, storagePath });

  if (!token || !signedUrl || !publicUrl) {
    return sendJson(
      res,
      502,
      errorBody("Signed upload URL is incomplete", [
        "Supabase did not return token, signedUrl, or publicUrl for the creative upload.",
      ]),
    );
  }

  return sendJson(
    res,
    200,
    success("supabase", {
      bucket,
      storageBucket: bucket,
      storagePath,
      signedUrl,
      token,
      publicUrl,
      fileName: normalized.fileName,
      fileType: normalized.fileType,
      mimeType: normalized.mimeType,
      fileSize: normalized.fileSize,
    }),
  );
}

async function handleMultipartAdCreativeUpload(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(
      res,
      503,
      errorBody("Supabase Storage is not configured", [
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for server-side creative upload.",
      ]),
    );
  }

  let form: MultipartFormData;
  try {
    form = parseMultipartFormData(await readRequestBuffer(req), getHeaderValue(req, "content-type"));
  } catch (error) {
    return sendJson(
      res,
      400,
      errorBody("Invalid multipart upload", [error instanceof Error ? error.message : "Could not parse multipart form data"]),
    );
  }

  if (!form.file) {
    return sendJson(res, 400, errorBody("Validation error", ["file is required"]));
  }

  const workspaceId = readWorkspaceId(req, form.fields);
  const fileName = firstString(form.fields.fileName, form.fields.file_name, form.file.fileName);
  const mimeType = inferMimeType({ fileName, mimeType: form.file.mimeType });
  // Storage-1: the browser never chooses the bucket or the object key.
  //
  // This branch writes with the service-role client, which bypasses Storage
  // RLS entirely, so a caller-supplied bucket or path was a tenant boundary
  // hole: any member holding manage_marketing could write under another
  // workspace's prefix, or into the private ad-creatives-raw bucket that
  // migration 016 states must never be served to Meta or end users. The
  // sibling signed-upload route already derives both server-side; this branch
  // now uses the same builder. No caller sends these fields — the UI is pinned
  // away from FormData by test:routes — so nothing legitimate changes.
  const storageBucket = AD_CREATIVE_BUCKET;
  const storagePath = buildAdCreativeStoragePath({ workspaceId, fileName });
  const metadata = {
    ...readJsonRecord(form.fields.metadata),
    source: firstString(asRecord(readJsonRecord(form.fields.metadata)).source, "ads-automation"),
    uploadMode: "server-storage",
  };
  const uploadBody: JsonRecord = {
    ...form.fields,
    workspaceId,
    uploadedBy: firstString(form.fields.uploadedBy, form.fields.uploaded_by),
    fileName,
    fileType: normalizeCreativeFileType({ ...form.fields, fileName, mimeType }),
    mimeType,
    fileSize: form.file.buffer.length,
    storageBucket,
    storagePath,
    status: "uploaded",
    metadata,
  };

  const details = validateCreativeAssetBody(uploadBody);
  if (details.length > 0) {
    return sendJson(res, 400, errorBody("Validation error", details));
  }

  const { error: uploadError } = await supabase.storage.from(storageBucket).upload(storagePath, form.file.buffer, {
    contentType: mimeType,
    upsert: false,
  });

  if (uploadError) {
    return sendJson(
      res,
      502,
      errorBody("Creative upload failed", [
        uploadError.message || "Supabase Storage did not accept the creative file.",
      ]),
    );
  }

  const publicUrl =
    supabase.storage.from(storageBucket).getPublicUrl(storagePath).data.publicUrl ||
    buildSupabaseStoragePublicUrl({ bucket: storageBucket, storagePath });

  if (!publicUrl) {
    return sendJson(
      res,
      502,
      errorBody("Creative public URL is missing", [
        "File was uploaded, but Supabase did not return a public URL. Check that bucket ad-creatives is public.",
      ]),
    );
  }

  const saved = await persistAdCreativeAsset({
    workspaceId,
    body: {
      ...uploadBody,
      publicUrl,
    },
  });

  return sendJson(
    res,
    saved.mode === "supabase" ? 201 : 200,
    success(
      saved.mode,
      {
        ...saved.asset,
        asset: saved.asset,
        item: saved.asset,
        uploadMode: "server-storage",
      },
      saved.warning || undefined,
    ),
  );
}

export async function handleAdCreativeUpload(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use POST"]));
  }

  if (isMultipartRequest(req)) {
    return handleMultipartAdCreativeUpload(req, res);
  }

  const body = asRecord(req.body);
  const details = validateCreativeAssetBody(body);
  if (details.length > 0) {
    return sendJson(res, 400, errorBody("Validation error", details));
  }

  const storageBucket = firstString(body.storageBucket, body.storage_bucket, "ad-creatives");
  const storagePath = firstString(body.storagePath, body.storage_path);
  const publicUrl = resolveAdCreativePublicUrl(body);
  if (!publicUrl) {
    return sendJson(res, 400, {
      success: false,
      error: "Не удалось получить публичную ссылку креатива",
      details: ["Файл загружен, но публичная ссылка не получена."],
      hint: storagePath
        ? "Storage bucket работает, но SUPABASE_URL не доступен серверу для сборки publicUrl."
        : "Проверьте, что Supabase Storage bucket ad-creatives создан, public access включён и upload response содержит storagePath.",
    });
  }

  const workspaceId = readWorkspaceId(req, body);
  const saved = await persistAdCreativeAsset({
    workspaceId,
    body: {
      ...body,
      workspaceId,
      status: readString(body.status) || "uploaded",
      storageBucket,
      storagePath,
      publicUrl,
    },
  });

  return sendJson(
    res,
    saved.mode === "supabase" ? 201 : 200,
    success(saved.mode, { ...saved.asset, asset: saved.asset, item: saved.asset }, saved.warning || undefined),
  );
}

export async function handleStorageHealth(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use GET"]));
  }

  const bucket = "ad-creatives";
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return sendJson(
      res,
      200,
      success("demo", {
        bucket,
        exists: false,
        publicAccess: false,
        canUpload: false,
        configured: false,
        hint: "SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY не настроены.",
      }),
    );
  }

  try {
    const { data, error } = await supabase.storage.getBucket(bucket);
    const bucketData = asRecord(data);
    const exists = !error && Boolean(data);
    const publicUrl = supabase.storage.from(bucket).getPublicUrl("_negis-storage-health.txt").data.publicUrl || "";

    return sendJson(
      res,
      200,
      success("supabase", {
        bucket,
        exists,
        publicAccess: Boolean(bucketData.public),
        canUpload: exists,
        publicUrlWorks: Boolean(publicUrl),
        samplePublicUrl: publicUrl,
        hint: exists
          ? "Bucket найден. Проверьте public access, если реальные креативы не открываются по ссылке."
          : "Bucket ad-creatives не найден. Примените migration 015 или создайте bucket вручную.",
      }),
    );
  } catch (error) {
    return sendJson(
      res,
      200,
      success("demo", {
        bucket,
        exists: false,
        publicAccess: false,
        canUpload: false,
        configured: true,
        hint: error instanceof Error ? error.message : "Не удалось проверить Supabase Storage.",
      }),
    );
  }
}

export async function handleAdCreativeMetaUpload(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use POST"]));
  }

  const body = asRecord(req.body);
  const workspaceId = readWorkspaceId(req, body);
  const assetId = firstString(body.assetId, body.id);
  const creativeType = normalizeCreativeFileType(body);
  const publicUrl = resolveAdCreativePublicUrl(body);
  const title = firstString(body.title, body.fileName, body.file_name, "Negis video creative");
  const fileName = firstString(body.fileName, body.file_name, title);
  const mimeType = firstString(body.mimeType, body.mime_type);

  if (creativeType === "image") {
    return sendJson(
      res,
      200,
      success("demo", {
        assetId,
        publicUrl,
        status: publicUrl ? "ready" : "missing_url",
        message: "Для фото отдельная загрузка в Meta не требуется. Ссылка будет использована в креативе автоматически.",
      }),
    );
  }

  // Reuse an already uploaded Meta video: re-check its processing status without a second upload.
  const existingMetaVideoId = firstString(body.metaVideoId, body.meta_video_id, body.videoId, body.video_id);
  if (existingMetaVideoId && !isDryRunMetaId(existingMetaVideoId) && !readBoolean(body.dryRun)) {
    if (!getMetaConfig().configured) {
      return sendJson(
        res,
        400,
        errorBody("Не удалось проверить видео в Meta", [
          "Meta env не настроены. Проверьте META_ACCESS_TOKEN, META_AD_ACCOUNT_ID и META_PAGE_ID в Vercel.",
        ]),
      );
    }

    try {
      const check = await checkMetaVideoProcessingStatus({ videoId: existingMetaVideoId });
      const lastCheckedAt = new Date().toISOString();
      await updateAdCreativeMeta({
        workspaceId,
        assetId,
        metaVideoId: existingMetaVideoId,
        status: check.ready ? "meta_uploaded" : "meta_processing",
        metadata: {
          processingStatus: check.status,
          processingProgress: check.progress ?? null,
          lastCheckedAt,
        },
      });
      return sendJson(
        res,
        check.ready ? 200 : 202,
        success("supabase", {
          assetId,
          metaVideoId: existingMetaVideoId,
          videoId: existingMetaVideoId,
          reused: true,
          videoReady: check.ready,
          processingStatus: check.status,
          processingProgress: check.progress,
          lastCheckedAt,
          status: check.ready ? "meta_uploaded" : "video_processing",
          message: check.ready
            ? "Видео в Meta готово. Можно создавать объявление."
            : META_VIDEO_PROCESSING_TIMEOUT_MESSAGE,
        }),
      );
    } catch (error) {
      const metaError = safeMetaLaunchError(error);
      const message = firstString(metaError.message, error instanceof Error ? error.message : "");
      return sendJson(res, 502, {
        ...errorBody("Meta не вернула статус видео", [message]),
        data: { metaError, metaVideoId: existingMetaVideoId, videoId: existingMetaVideoId },
      });
    }
  }

  if (!publicUrl) {
    return sendJson(
      res,
      400,
      errorBody("Не удалось получить публичную ссылку креатива", [
        "Видео загружено в Negis, но публичная ссылка не получена. Проверьте Supabase Storage bucket ad-creatives.",
      ]),
    );
  }

  if (readBoolean(body.dryRun)) {
    const metaVideoId = demoMetaId("video");
    return sendJson(
      res,
      200,
      success("demo", {
        assetId,
        metaVideoId,
        status: "dry_run",
        message: "Проверка прошла без запуска: видео не отправлялось в Meta.",
      }),
    );
  }

  if (!isMetaVideoLaunchEnabled()) {
    return sendJson(
      res,
      409,
      {
        ...errorBody("Meta video launch is not ready", [META_VIDEO_LAUNCH_DISABLED_MESSAGE]),
        data: {
          assetId,
          publicUrl,
          status: "blocked",
          featureFlag: "META_VIDEO_LAUNCH_ENABLED",
          metaApiCalled: false,
        },
      },
    );
  }

  if (!isSupportedMetaVideoFormat({ fileName, mimeType })) {
    return sendJson(res, 400, errorBody("Validation error", [META_VIDEO_FORMAT_ERROR]));
  }

  if (!getMetaConfig().configured) {
    return sendJson(
      res,
      400,
      errorBody("Не удалось загрузить видео в Meta", [
        "Meta env не настроены. Проверьте META_ACCESS_TOKEN, META_AD_ACCOUNT_ID и META_PAGE_ID в Vercel.",
      ]),
    );
  }

  try {
    const metaResponse = await uploadMetaVideoAndGetId({ videoUrl: publicUrl, fileName, mimeType, title });
    const metaVideoId = metaResponse.videoId;
    const lastCheckedAt = new Date().toISOString();

    await updateAdCreativeMeta({
      workspaceId,
      assetId,
      metaVideoId,
      status: "meta_uploaded",
      metadata: { metaResponse, processingStatus: metaResponse.processingStatus, lastCheckedAt },
    });

    return sendJson(
      res,
      200,
      success("supabase", {
        assetId,
        metaVideoId,
        videoId: metaVideoId,
        uploadMode: metaResponse.uploadMode,
        videoReady: true,
        processingStatus: metaResponse.processingStatus,
        lastCheckedAt,
        warnings: metaResponse.warnings || [],
        status: "meta_uploaded",
        metaResponse,
      }, metaResponse.warnings?.join(" ") || (mimeType === "video/quicktime" ? META_MOV_VIDEO_WARNING : undefined)),
    );
  } catch (error) {
    // Video accepted by Meta but still processing: keep the video_id so the next attempt reuses it.
    if (isMetaVideoProcessingPendingError(error)) {
      const debug = asRecord(error.details.debug);
      const pendingVideoId = firstString(debug.videoId);
      if (pendingVideoId) {
        const processingStatus = firstString(debug.status) || "processing";
        const lastCheckedAt = new Date().toISOString();
        await updateAdCreativeMeta({
          workspaceId,
          assetId,
          metaVideoId: pendingVideoId,
          status: "meta_processing",
          metadata: { processingStatus, lastCheckedAt },
        });
        return sendJson(
          res,
          202,
          success("supabase", {
            assetId,
            metaVideoId: pendingVideoId,
            videoId: pendingVideoId,
            videoReady: false,
            processingStatus,
            lastCheckedAt,
            status: "video_processing",
            message: META_VIDEO_PROCESSING_TIMEOUT_MESSAGE,
          }),
        );
      }
    }
    const metaError = safeMetaLaunchError(error);
    const message = firstString(metaError.message, error instanceof Error ? error.message : "");
    return sendJson(
      res,
      metaError.step === "video_processing" ? 409 : 502,
      {
        ...errorBody("Видео загружено в Negis, но Meta не приняла видео", [message]),
        data: { metaError },
      },
    );
  }
}

export async function handleVideoJobs(req: VercelRequest, res: VercelResponse) {
  const config = videoOptimizationConfig();
  const rawBucket = config.rawBucket;

  if (req.method === "GET") {
    const jobId = readQueryString(req.query.id);
    if (!jobId) {
      return sendJson(res, 400, errorBody("Validation error", ["id is required"]));
    }
    const supabase = getSupabaseServerClient();
    if (!supabase || !isUuid(jobId)) {
      // Demo mode has no persistent jobs: report the job as queued so the UI can
      // explain that the worker is not available in this environment.
      return sendJson(
        res,
        200,
        success("demo", { job: makeVideoJob({ id: jobId, status: "queued" }) }, "Supabase не настроен: статус задачи оптимизации недоступен в demo-режиме."),
      );
    }
    try {
      const workspaceId = readWorkspaceId(req, {});
      // The tenant filter below is not optional. Everywhere else in this file
      // the workspace is applied unconditionally; here it was applied only when
      // it happened to be a UUID, so a missing context would have silently
      // dropped it and let the query see another clinic's job. The router never
      // reaches a browser route without a verified workspace, which is exactly
      // why an unverified one must end the request rather than widen it.
      if (!isUuid(workspaceId)) throw new Error("workspace is not verified");
      const query = supabase
        .from("video_processing_jobs")
        .select("*")
        .eq("id", jobId)
        .eq("workspace_id", workspaceId);
      const { data, error } = await query.single();
      if (error) throw new Error(error.message);
      return sendJson(res, 200, success("supabase", { job: makeVideoJob(asRecord(data)) }));
    } catch (error) {
      return sendJson(res, 404, {
        ...errorBody("Задача оптимизации не найдена", [redactedDetail("video job lookup", error, "not found")]),
      });
    }
  }

  if (req.method === "POST") {
    const body = asRecord(req.body);
    if (!config.enabled) {
      return sendJson(res, 409, {
        ...errorBody("Оптимизация видео выключена", [VIDEO_OPTIMIZATION_DISABLED_MESSAGE]),
        data: { videoOptimization: config },
      });
    }

    const workspaceId = readWorkspaceId(req, body);
    const fileName = firstString(body.fileName, body.file_name);
    const mimeType = inferMimeType({ fileName, mimeType: firstString(body.mimeType, body.mime_type) });
    const fileSize = readNumber(body.fileSize ?? body.file_size) ?? 0;
    const maxInputBytes = config.maxInputMb * 1024 * 1024;
    const details: string[] = [];
    if (!fileName) details.push("fileName is required");
    if (!VIDEO_MIME_TYPES.has(mimeType)) details.push("Для оптимизации поддерживаются только видео MP4, MOV или WEBM.");
    if (fileSize <= 0) details.push("fileSize is required");
    if (fileSize > maxInputBytes) details.push(`Видео больше ${config.maxInputMb} MB. Загрузите файл меньшего размера.`);
    if (details.length > 0) {
      return sendJson(res, 400, errorBody("Validation error", details));
    }

    const supabase = getSupabaseServerClient();
    // A job row with workspace_id null belongs to no clinic, and the worker
    // processes it all the same: it downloads the raw object, publishes the
    // result to the public bucket and deletes the original. Without a verified
    // workspace there is nothing to file it under, so it stays a demo answer.
    if (!supabase || !isUuid(workspaceId)) {
      return sendJson(
        res,
        200,
        success(
          "demo",
          {
            job: makeVideoJob({
              workspaceId,
              status: "awaiting_upload",
              sourceFileName: fileName,
              sourceMimeType: mimeType,
              rawSize: fileSize,
            }),
            signedUpload: null,
            assetId: "",
          },
          "Supabase Storage не настроен: загрузка исходника недоступна в demo-режиме.",
        ),
      );
    }

    const storagePath = buildAdCreativeStoragePath({ workspaceId, fileName });
    const { data: signed, error: signedError } = await supabase.storage.from(rawBucket).createSignedUploadUrl(storagePath);
    if (signedError || !signed?.token) {
      return sendJson(res, 502, {
        ...errorBody("Не удалось создать ссылку для загрузки исходника", [
          signedError?.message || "signed upload URL is missing",
          `Проверьте, что bucket ${rawBucket} создан (migration 016).`,
        ]),
      });
    }

    let assetId = "";
    try {
      const assetRow = configs["ad-creatives"].toRow(
        {
          uploadedBy: firstString(body.uploadedBy, body.uploaded_by),
          fileName,
          fileType: "video",
          mimeType,
          fileSize,
          storageBucket: rawBucket,
          storagePath,
          status: "optimizing",
          metadata: { source: "ads-automation", optimization: "pending" },
        },
        workspaceId,
      );
      const { data: assetData, error: assetError } = await supabase.from("ad_creative_assets").insert(assetRow).select("id").single();
      if (assetError) throw new Error(assetError.message);
      assetId = firstString(asRecord(assetData).id);
    } catch (error) {
      console.warn(supabaseWarning("ad_creative_assets optimizing insert", error));
    }

    try {
      const { data: jobData, error: jobError } = await supabase
        .from("video_processing_jobs")
        .insert({
          workspace_id: workspaceId,
          asset_id: isUuid(assetId) ? assetId : null,
          status: "awaiting_upload",
          raw_bucket: rawBucket,
          raw_path: storagePath,
          source_file_name: fileName,
          source_mime_type: mimeType,
          metadata: { source: "ads-automation" },
        })
        .select("*")
        .single();
      if (jobError) throw new Error(jobError.message);
      return sendJson(
        res,
        201,
        success("supabase", {
          job: makeVideoJob(asRecord(jobData)),
          signedUpload: {
            bucket: rawBucket,
            storageBucket: rawBucket,
            storagePath,
            token: signed.token,
            signedUrl: firstString(asRecord(signed as unknown as JsonRecord).signedUrl),
          },
          assetId,
        }),
      );
    } catch (error) {
      return sendJson(res, 502, {
        ...errorBody("Не удалось создать задачу оптимизации", [
          redactedDetail("video job insert", error, SERVICE_FAILURE_DETAIL),
          "Проверьте, что migration 016 применена (таблица video_processing_jobs).",
        ]),
      });
    }
  }

  if (req.method === "PATCH") {
    const body = asRecord(req.body);
    const jobId = firstString(body.id, body.jobId, readQueryString(req.query.id));
    if (!jobId) {
      return sendJson(res, 400, errorBody("Validation error", ["id is required"]));
    }
    const rawSize = readNumber(body.rawSize ?? body.raw_size) ?? null;

    const supabase = getSupabaseServerClient();
    if (!supabase || !isUuid(jobId)) {
      return sendJson(
        res,
        200,
        success("demo", { job: makeVideoJob({ id: jobId, status: "queued", rawSize }) }, "Supabase не настроен: задача помечена queued только в ответе."),
      );
    }

    try {
      const workspaceId = readWorkspaceId(req, body);
      // Only the awaiting_upload → queued transition is allowed from the frontend;
      // every other status belongs to the worker.
      // The tenant filter below is not optional. Everywhere else in this file
      // the workspace is applied unconditionally; here it was applied only when
      // it happened to be a UUID, so a missing context would have silently
      // dropped it and let the query see another clinic's job. The router never
      // reaches a browser route without a verified workspace, which is exactly
      // why an unverified one must end the request rather than widen it.
      if (!isUuid(workspaceId)) throw new Error("workspace is not verified");
      const update = supabase
        .from("video_processing_jobs")
        .update({ status: "queued", raw_size: rawSize, updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("status", "awaiting_upload")
        .eq("workspace_id", workspaceId);
      const { data, error } = await update.select("*").maybeSingle();
      if (error) throw new Error(error.message);
      if (data) {
        return sendJson(res, 200, success("supabase", { job: makeVideoJob(asRecord(data)) }));
      }
      const { data: current, error: currentError } = await supabase.from("video_processing_jobs").select("*").eq("id", jobId).single();
      if (currentError) throw new Error(currentError.message);
      return sendJson(
        res,
        200,
        success("supabase", { job: makeVideoJob(asRecord(current)) }, "Задача уже не в статусе awaiting_upload."),
      );
    } catch (error) {
      return sendJson(res, 404, {
        ...errorBody("Задача оптимизации не найдена", [redactedDetail("video job lookup", error, "not found")]),
      });
    }
  }

  return sendJson(res, 405, errorBody("Method not allowed", ["Use GET, POST or PATCH"]));
}

export async function handleVideoProcessingJobs(req: VercelRequest, res: VercelResponse, pathSegments: string[] = []) {
  const config = videoOptimizationConfig();
  const rawBucket = firstString(config.rawBucket, DEFAULT_RAW_VIDEO_BUCKET);
  const pathJobId = firstString(pathSegments[0], readQueryString(req.query.id));
  const action = firstString(pathSegments[1]).toLowerCase();

  if (req.method === "GET") {
    const jobId = pathJobId;
    if (!jobId) {
      return sendJson(res, 400, errorBody("Validation error", ["id is required"]));
    }

    const supabase = getSupabaseServerClient();
    if (!supabase || !isUuid(jobId)) {
      return sendJson(
        res,
        200,
        success("demo", { job: makeVideoJob({ id: jobId, status: "queued" }) }, "Supabase не настроен: статус задачи доступен только как demo-ответ."),
      );
    }

    try {
      const workspaceId = readWorkspaceId(req, {});
      // The tenant filter below is not optional. Everywhere else in this file
      // the workspace is applied unconditionally; here it was applied only when
      // it happened to be a UUID, so a missing context would have silently
      // dropped it and let the query see another clinic's job. The router never
      // reaches a browser route without a verified workspace, which is exactly
      // why an unverified one must end the request rather than widen it.
      if (!isUuid(workspaceId)) throw new Error("workspace is not verified");
      const query = supabase
        .from("video_processing_jobs")
        .select("*")
        .eq("id", jobId)
        .eq("workspace_id", workspaceId);
      const { data, error } = await query.single();
      if (error) throw new Error(error.message);
      return sendJson(res, 200, success("supabase", { job: makeVideoJob(asRecord(data)) }));
    } catch (error) {
      return sendJson(res, 404, errorBody("Задача оптимизации не найдена", [redactedDetail("video job lookup", error, "not found")]));
    }
  }

  if (req.method === "POST" && action === "retry") {
    const jobId = pathJobId;
    if (!jobId) {
      return sendJson(res, 400, errorBody("Validation error", ["id is required"]));
    }

    const body = asRecord(req.body);
    const supabase = getSupabaseServerClient();
    if (!supabase || !isUuid(jobId)) {
      const status = firstString(body.status, "failed").toLowerCase();
      if (status !== "failed") {
        return sendJson(res, 409, errorBody("Retry is not allowed", ["Only failed jobs can be retried"]));
      }
      return sendJson(
        res,
        200,
        success("demo", { job: makeVideoJob({ id: jobId, status: "queued", progress: 0 }) }, "Supabase не настроен: retry выполнен только в demo-ответе."),
      );
    }

    try {
      const workspaceId = readWorkspaceId(req, body);
      // Same rule as the lookups above: the workspace is applied
      // unconditionally, and an unverified one ends the request.
      if (!isUuid(workspaceId)) throw new Error("workspace is not verified");
      const update = supabase
        .from("video_processing_jobs")
        .update({
          status: "queued",
          progress: 0,
          error: null,
          error_message: null,
          started_at: null,
          completed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .eq("status", "failed")
        .eq("workspace_id", workspaceId);
      const { data, error } = await update.select("*").maybeSingle();
      if (error) throw new Error(error.message);
      if (data) return sendJson(res, 200, success("supabase", { job: makeVideoJob(asRecord(data)) }));

      // Storage-1: this second lookup exists to tell "job is not failed" (409)
      // from "job does not exist" (404). Unscoped, it answered 409 for a job in
      // someone else's workspace, which turned the route into a cross-tenant
      // existence oracle. Scoped, a foreign id is indistinguishable from a
      // missing one.
      const { data: current, error: currentError } = await supabase
        .from("video_processing_jobs")
        .select("status")
        .eq("id", jobId)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (currentError) throw new Error(currentError.message);
      if (current) {
        return sendJson(res, 409, errorBody("Retry is not allowed", ["Only failed jobs can be retried"]));
      }
      return sendJson(res, 404, errorBody("Задача оптимизации не найдена", ["not found"]));
    } catch (error) {
      return sendJson(res, 502, errorBody("Не удалось повторить задачу оптимизации", [redactedDetail("video job retry", error, SERVICE_FAILURE_DETAIL)]));
    }
  }

  if (req.method === "POST") {
    const body = asRecord(req.body);
    const workspaceId = readWorkspaceId(req, body);
    const assetId = firstString(body.assetId, body.asset_id);
    const rawPath = firstString(body.rawPath, body.raw_path);
    const rawPublicUrl = firstString(body.rawPublicUrl, body.raw_public_url);
    const inputMimeType = inferMimeType({
      fileName: firstString(body.fileName, body.file_name, "video.mp4"),
      mimeType: firstString(body.inputMimeType, body.input_mime_type, body.mimeType, body.mime_type),
    });
    const inputSizeBytes = readNumber(body.inputSizeBytes ?? body.input_size_bytes ?? body.fileSize ?? body.file_size) ?? 0;
    const fileName = firstString(body.fileName, body.file_name);
    const details: string[] = [];

    if (!VIDEO_MIME_TYPES.has(inputMimeType)) details.push("inputMimeType must be MP4, MOV or WEBM");
    if (inputSizeBytes <= 0) details.push("inputSizeBytes is required");
    if (inputSizeBytes > config.maxInputMb * 1024 * 1024) details.push(`Видео больше ${config.maxInputMb} MB. Загрузите файл меньшего размера.`);
    if (rawPath && !isOwnWorkspaceStoragePath(rawPath, workspaceId)) {
      details.push("rawPath must point at an object inside this workspace");
    }
    if (details.length > 0) return sendJson(res, 400, errorBody("Validation error", details));

    const demoJob = makeVideoJob({
      workspaceId,
      assetId,
      status: "queued",
      progress: 0,
      rawBucket,
      rawPath,
      rawPublicUrl,
      sourceFileName: fileName,
      inputMimeType,
      inputSizeBytes,
    });
    const supabase = getSupabaseServerClient();
    // Same rule as /api/crm/video-jobs: no verified workspace, no row.
    if (!supabase || !isUuid(workspaceId)) {
      return sendJson(
        res,
        200,
        success("demo", { job: demoJob }, "Supabase не настроен: задача оптимизации создана только как demo-ответ."),
      );
    }

    try {
      const { data, error } = await supabase
        .from("video_processing_jobs")
        .insert({
          workspace_id: workspaceId,
          asset_id: isUuid(assetId) ? assetId : null,
          status: "queued",
          progress: 0,
          raw_bucket: rawBucket,
          raw_path: rawPath || null,
          raw_public_url: rawPublicUrl || null,
          source_file_name: fileName || null,
          source_mime_type: inputMimeType,
          input_mime_type: inputMimeType,
          raw_size: inputSizeBytes,
          input_size_bytes: inputSizeBytes,
          output_bucket: "ad-creatives",
          optimized_bucket: "ad-creatives",
          metadata: { source: "video-processing-jobs-api", fileName },
        })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return sendJson(res, 201, success("supabase", { job: makeVideoJob(asRecord(data)) }));
    } catch (error) {
      // Security-2F: a job the database refused has no id to poll, so reporting
      // it as queued left the browser watching a job that never existed.
      return sendJson(
        res,
        502,
        errorBody("Не удалось создать задачу оптимизации", [
          redactedDetail("video_processing_jobs insert", error, SERVICE_FAILURE_DETAIL),
        ]),
      );
    }
  }

  return sendJson(res, 405, errorBody("Method not allowed", ["Use GET or POST"]));
}

function normalizeLeadDestination(value: unknown): "whatsapp" | "instagram_profile" | "website" | "lead_form" | "call" {
  const text = readString(value).toLowerCase();
  if (text.includes("instagram")) return "instagram_profile";
  if (text.includes("website") || text.includes("site") || text.includes("landing")) return "website";
  if (text.includes("form")) return "lead_form";
  if (text.includes("call") || text.includes("phone")) return "call";
  return "whatsapp";
}

function leadDestinationLabel(value: unknown): string {
  const destination = normalizeLeadDestination(value);
  const labels = {
    whatsapp: "WhatsApp",
    instagram_profile: "Instagram профиль",
    website: "Сайт/лендинг",
    lead_form: "Meta Lead Form",
    call: "Звонок",
  };
  return labels[destination];
}

function buildDestinationUrl(destination: string, value: string): string {
  const normalized = normalizeLeadDestination(destination);
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (normalized === "whatsapp") {
    const digits = trimmed.replace(/\D/g, "");
    return digits ? `https://wa.me/${digits}` : trimmed;
  }

  if (normalized === "instagram_profile") {
    if (trimmed.startsWith("http")) return trimmed;
    return `https://instagram.com/${trimmed.replace(/^@/, "")}`;
  }

  if (normalized === "call") {
    return `tel:${trimmed.replace(/[^\d+]/g, "")}`;
  }

  return trimmed;
}

function ctaForDestination(destination: string): string {
  const normalized = normalizeLeadDestination(destination);
  if (normalized === "whatsapp") return "CONTACT_US";
  if (normalized === "call") return "CALL_NOW";
  return "LEARN_MORE";
}

function safeMedicalAdText(input: { service: string; city: string; offer: string }): string {
  const service = input.service || "консультация специалиста";
  const city = input.city || "вашем городе";
  const offer = input.offer || "подбор подходящего решения";
  return `${service} в ${city}. ${offer}. Запишитесь на консультацию: специалист объяснит варианты и поможет выбрать следующий шаг.`;
}

function buildAdsAiFallback(body: JsonRecord): JsonRecord {
  const service = firstString(body.service, body.niche, "Консультация специалиста");
  const city = firstString(body.city, "Астана");
  const offer = firstString(body.offer, "консультация и диагностика");
  const leadDestination = firstString(body.leadDestination, body.lead_destination, "whatsapp");
  const destinationValue = firstString(body.destinationValue, body.destination_value, body.landingUrl, body.phone);
  const destinationUrl = buildDestinationUrl(leadDestination, destinationValue);
  const dailyBudget = readNumber(body.dailyBudget ?? body.daily_budget ?? body.budget) ?? 20;
  const startDate = firstString(body.startDate, body.start_date, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const endDate = firstString(body.endDate, body.end_date);
  const creativeType = normalizeCreativeFileType(body);
  const primaryText = safeMedicalAdText({ service, city, offer });
  const objective =
    normalizeLeadDestination(leadDestination) === "instagram_profile"
      ? "OUTCOME_TRAFFIC"
      : normalizeLeadDestination(leadDestination) === "lead_form"
        ? "OUTCOME_LEADS"
        : "OUTCOME_LEADS";
  const cta = ctaForDestination(leadDestination);
  const audience = firstString(body.knownAudience, body.known_audience, body.targetAudience, "Жители города 25-55, интересующиеся услугами клиники");

  return {
    campaignName: `${service} - ${city} - заявки`,
    objective,
    objectiveLabel: objective === "OUTCOME_TRAFFIC" ? "Цель: переходы" : "Цель: заявки",
    primaryText,
    headline: `${service} в ${city}`,
    description: "Консультация без обещаний результата. Решение принимает специалист после осмотра.",
    cta,
    ctaLabel: cta === "CONTACT_US" ? "Кнопка: Написать" : cta === "CALL_NOW" ? "Кнопка: Позвонить" : "Кнопка: Подробнее",
    destinationLabel: leadDestinationLabel(leadDestination),
    destinationUrl,
    audience,
    targeting: {
      geo_locations: { countries: ["KZ"] },
      age_min: 25,
      age_max: 55,
      publisher_platforms: ["instagram"],
      instagram_positions: ["stream", "story", "explore", "reels"],
    },
    placements: ["Instagram Feed", "Instagram Stories", "Instagram Explore", "Instagram Reels"],
    budgetPlan: {
      dailyBudget,
      currency: "USD",
      startDate,
      endDate,
      recommendation: "Начать с небольшого дневного бюджета и оценить заявки через 48-72 часа.",
    },
    metaPayloadPreview: {
      campaign: "Кампания",
      adSet: "Группа объявлений",
      creative: creativeType === "video" ? "Видео-креатив" : "Фото-креатив",
      ad: "Объявление",
      statusMode: "PAUSED",
    },
    humanReport: {
      summary: `ИИ подготовил рекламу услуги "${service}" для города ${city}.`,
      whatWillRun: `${creativeType === "video" ? "Видео" : "Фото"} + безопасный текст объявления + кнопка ${cta === "CONTACT_US" ? "Написать" : "Подробнее"}.`,
      whereLeadsGo: destinationUrl || "Адрес для заявок нужно указать перед запуском.",
      risks: [
        "Не использовать обещания результата.",
        "Не обращаться к человеку через диагноз или внешность.",
        "Перед ACTIVE запуском проверить бюджет и ссылку для заявок.",
      ],
      recommendations: [
        "Сначала создать кампанию выключенной.",
        "Проверить предпросмотр в Ads Manager.",
        "Запустить ACTIVE только после ручного подтверждения.",
      ],
    },
    safeWording: {
      blockedPhrases: ["гарантируем", "у вас проблема", "до/после гарантировано"],
      fixedText: primaryText,
    },
  };
}

async function parseCrmFetchJson(response: CrmFetchResponse): Promise<JsonRecord> {
  const raw = await response.text();
  if (!raw.trim()) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    return asRecord(parsed);
  } catch {
    return { raw: raw.slice(0, 500) };
  }
}

type OpenAiContentItem = {
  text: string;
  value: string;
};

function normalizeOpenAiContentItems(value: unknown): OpenAiContentItem[] {
  if (!Array.isArray(value)) return [];

  return value.map((item) => {
    const record = asRecord(item);
    return {
      text: firstString(record.text),
      value: firstString(record.value),
    };
  });
}

function extractOpenAiText(data: JsonRecord): string {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice.message);
  const content = message.content;
  if (typeof content === "string") return content;

  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    const contentItems = normalizeOpenAiContentItems(asRecord(item).content);
    for (const contentItem of contentItems) {
      const text = firstString(contentItem.text, contentItem.value);
      if (text) return text;
    }
  }

  return "";
}

async function tryOpenAiAdsFill(body: JsonRecord, fallback: JsonRecord): Promise<{ data: JsonRecord | null; warning?: string }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return { data: null };

  try {
    const safeFetch = fetch as unknown as CrmFetch;
    const response = await safeFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_ADS_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
        temperature: 0.35,
        messages: [
          {
            role: "system",
            content:
              "Ты senior performance marketer для медицинской CRM. Верни только JSON без markdown. Пиши по-русски. Не используй обещания результата, диагнозы, давление на внешность, до/после гарантировано.",
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Заполни безопасный пакет Meta Ads для сотрудника клиники.",
              expectedKeys: Object.keys(fallback),
              input: sanitizeLaunchPayload(body),
              fallback,
            }),
          },
        ],
      }),
    });

    const responseBody = await parseCrmFetchJson(response);
    if (!response.ok) {
      return {
        data: null,
        warning: `OpenAI не ответил успешно: ${firstString(asRecord(responseBody.error).message, responseBody.raw, `HTTP ${response.status}`)}`,
      };
    }

    const text = extractOpenAiText(responseBody);
    if (!text) return { data: null, warning: "OpenAI вернул пустой ответ, использован demo fallback" };

    const parsed = JSON.parse(text) as unknown;
    const aiData = asRecord(parsed);
    return {
      data: {
        ...fallback,
        ...aiData,
        humanReport: {
          ...asRecord(fallback.humanReport),
          ...asRecord(aiData.humanReport),
        },
      },
    };
  } catch (error) {
    return {
      data: null,
      warning: error instanceof Error ? `OpenAI fallback: ${error.message}` : "OpenAI fallback: неизвестная ошибка",
    };
  }
}

export async function handleAdsAiFill(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use POST"]));
  }

  const body = asRecord(req.body);
  const details: string[] = [];
  if (!firstString(body.service, body.niche)) details.push("service is required");
  if (!firstString(body.city)) details.push("city is required");
  if (!firstString(body.leadDestination, body.lead_destination)) details.push("leadDestination is required");
  if ((readNumber(body.dailyBudget ?? body.daily_budget ?? body.budget) ?? 0) <= 0) details.push("dailyBudget is required");

  if (details.length > 0) {
    return sendJson(res, 400, errorBody("Validation error", details));
  }

  const fallback = buildAdsAiFallback(body);
  const openAi = await tryOpenAiAdsFill(body, fallback);
  const aiPackage = openAi.data || fallback;

  return sendJson(
    res,
    200,
    success(
      "demo",
      {
        ...aiPackage,
        generatedBy: openAi.data ? "openai" : "demo",
      },
      openAi.warning || (!openAi.data && process.env.OPENAI_API_KEY ? "OpenAI недоступен, использован demo fallback" : undefined),
    ),
  );
}

const META_MAX_DAILY_BUDGET = 50;
const META_MAX_TOTAL_BUDGET = 300;
const META_TIMESTAMP_SUFFIX = /\s+-\s+\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/;

function normalizeLaunchTimestamp(value: unknown): string {
  const timestamp = readString(value);
  return /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/.test(timestamp) ? timestamp : "";
}

function stripLaunchTimestamp(value: string): string {
  return value.replace(META_TIMESTAMP_SUFFIX, "").trim();
}

function withLaunchTimestamp(value: string, timestamp: string): string {
  const base = stripLaunchTimestamp(value).trim();
  return base ? `${base} - ${timestamp}` : timestamp;
}

function audienceAgeLabel(value: string): string {
  const match = value.match(/(\d{2})\s*[-–]\s*(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : "25-55";
}

function normalizeMetaStatus(value: unknown): "PAUSED" | "ACTIVE" {
  return readString(value).toUpperCase() === "ACTIVE" ? "ACTIVE" : "PAUSED";
}

function budgetToMinor(value: unknown): number {
  const amount = readNumber(value);
  if (!amount || amount <= 0) return 0;
  return Math.round(amount * 100);
}

function dateDays(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 1;
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
}

function roleCanLaunchActive(role: string): boolean {
  return ["owner", "admin"].includes(role.trim().toLowerCase());
}

function demoMetaId(prefix: string) {
  return `dryrun_${prefix}_${Date.now()}`;
}

function isDryRunMetaId(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("dryrun_");
}

function isMetaVideoProcessingPendingError(error: unknown): error is MetaApiError {
  return error instanceof MetaApiError && error.details.step === "video_processing" && error.details.pending === true;
}

function localizeMetaLaunchError(message: string) {
  const text = message || "Meta API вернул ошибку. Кампания не создана.";
  const normalized = text.toLowerCase();

  if (normalized.includes("meta env is not configured") || normalized.includes("meta env")) {
    return "Meta env не настроены. Проверьте META_ACCESS_TOKEN, META_AD_ACCOUNT_ID и META_PAGE_ID в Vercel.";
  }

  if (normalized.includes("video") && (normalized.includes("url") || normalized.includes("public"))) {
    return "Видео загружено в Negis, но публичная ссылка не получена. Проверьте Supabase Storage bucket ad-creatives.";
  }

  if (normalized.includes("permission") || normalized.includes("permissions") || normalized.includes("unsupported post request")) {
    return "Meta отклонила запрос. Проверьте права access token, ad account, page и instagram actor.";
  }

  if (normalized.includes("invalid parameter") || normalized.includes("param")) {
    return `Meta отклонила параметры кампании: ${text}`;
  }

  return text;
}

function safeMetaLaunchError(error: unknown): JsonRecord {
  if (error instanceof MetaApiError) {
    const details = error.details;
    return {
      step: details.step || "meta",
      message: localizeMetaLaunchError(details.message),
      rawMessage: details.message,
      status: details.status,
      code: details.code,
      error_subcode: details.errorSubcode,
      error_user_msg: details.errorUserMsg,
      blame_field_specs: details.blameFieldSpecs,
      fbtrace_id: details.fbtraceId,
      debug: details.debug,
    };
  }

  const message = error instanceof Error ? error.message : "Не удалось создать рекламу в Meta";
  return {
    step: "meta",
    message: localizeMetaLaunchError(message),
    rawMessage: message,
  };
}

async function readMetaLiveLaunchEnabled(workspaceId: string, body: JsonRecord): Promise<boolean> {
  const requested = readBoolean(body.liveLaunchEnabled);
  const supabase = getSupabaseServerClient();

  if (!supabase || !isUuid(workspaceId)) {
    return requested;
  }

  try {
    const { data, error } = await supabase
      .from("workspace_settings")
      .select("value")
      .eq("workspace_id", workspaceId)
      .eq("key", "meta_live_launch_enabled")
      .maybeSingle();

    if (error) throw new Error(error.message);
    const value = asRecord(asRecord(data).value);
    if (Object.prototype.hasOwnProperty.call(value, "enabled")) {
      return readBoolean(value.enabled);
    }
  } catch (error) {
    console.warn(supabaseWarning("workspace_settings meta_live_launch_enabled", error));
  }

  return requested;
}

function buildMetaLaunchBody(body: JsonRecord) {
  const service = firstString(body.service, body.niche, body.offer, body.campaignService, "Consultation");
  const rawSelectedCity = firstString(body.selectedCityId, body.selected_city_id, body.cityId, body.city_id, body.city, "astana");
  const matchedCity = findKzMetaCityOption(rawSelectedCity);
  const selectedCity = matchedCity || getKzMetaCityOption("astana");
  const city = selectedCity.labelRu;
  const targetAudience = firstString(body.targetAudience, body.target_audience, "Women 25-55");
  const launchTimestamp = normalizeLaunchTimestamp(body.launchTimestamp ?? body.launch_timestamp) || formatKazakhstanTimestamp();
  const baseCampaignName = firstString(body.campaignName, body.campaign_name, `${service} - ${city} - заявки`);
  const campaignName = withLaunchTimestamp(baseCampaignName, launchTimestamp);
  const audienceLabel = audienceAgeLabel(targetAudience);
  const adSetName = withLaunchTimestamp(`${city} - Instagram - ${audienceLabel}`, launchTimestamp);
  const creativeName = withLaunchTimestamp(`Креатив - ${service}`, launchTimestamp);
  const adName = withLaunchTimestamp(`Объявление - ${service}`, launchTimestamp);
  const primaryText = firstString(body.primaryText, body.primary_text, body.creativeText, body.caption);
  const headline = firstString(body.headline, campaignName);
  const description = firstString(body.description, body.offer, body.service, body.niche);
  const dailyBudget = readNumber(body.dailyBudget ?? body.daily_budget ?? body.budget) ?? 0;
  const days = dateDays(firstString(body.startDate, body.start_time), firstString(body.endDate, body.end_time));
  const totalBudget = readNumber(body.totalBudget ?? body.total_budget) ?? dailyBudget * days;
  const config = getMetaConfig();
  const creativeType = normalizeCreativeFileType(body);
  const fileName = firstString(body.fileName, body.file_name);
  const mimeType = firstString(body.mimeType, body.mime_type);
  const fileSize = readNumber(body.fileSize ?? body.file_size) ?? 0;
  const creativeUrl = firstString(body.creativeUrl, body.creative_url);
  const imageUrl = creativeType === "image" ? firstString(body.imageUrl, body.image_url, creativeUrl) : firstString(body.imageUrl, body.image_url);
  const videoUrl = creativeType === "video" ? firstString(body.videoUrl, body.video_url, creativeUrl) : firstString(body.videoUrl, body.video_url);
  const metaCityKey = firstString(
    body.metaCityKey,
    body.meta_city_key,
    body.cityKey,
    body.city_key,
    body.astanaCityKey,
    body.astana_city_key,
    body.metaAstanaCityKey,
    body.meta_astana_city_key,
  );

  return {
    campaignName,
    objective: firstString(body.objective, "OUTCOME_LEADS"),
    statusMode: normalizeMetaStatus(body.statusMode ?? body.status),
    dailyBudget,
    totalBudget,
    dailyBudgetMinor: budgetToMinor(dailyBudget),
    totalBudgetMinor: budgetToMinor(totalBudget),
    currency: readString(body.currency) || "USD",
    service,
    city,
    selectedCityId: selectedCity.id,
    selectedCityLabelRu: selectedCity.labelRu,
    selectedCityCanonicalName: selectedCity.canonicalName,
    selectedCityValid: Boolean(matchedCity),
    targetAudience,
    audienceLabel,
    launchTimestamp,
    adSetName,
    creativeName,
    adName,
    primaryText,
    headline,
    description,
    cta: firstString(body.cta, "LEARN_MORE").toUpperCase().replace(/\s+/g, "_"),
    landingUrl: firstString(body.landingUrl, body.landing_url, body.websiteUrl, body.website_url),
    imageUrl,
    creativeUrl,
    creativeType,
    fileName,
    mimeType,
    fileSize,
    videoUrl,
    videoId: firstString(body.videoId, body.video_id, body.metaVideoId, body.meta_video_id),
    thumbnailUrl: firstString(body.thumbnailUrl, body.thumbnail_url),
    startDate: firstString(body.startDate, body.start_time, new Date(Date.now() + 3600000).toISOString()),
    endDate: firstString(body.endDate, body.end_time),
    pageId: config.pageId,
    instagramActorId: config.instagramActorId,
    metaCityKey,
    astanaCityKey: metaCityKey,
    adAccountId: config.adAccountId,
  };
}

type ResolvedMetaLaunchBody = ReturnType<typeof buildMetaLaunchBody> & {
  targetingResolution?: MetaTargetingResolution;
};

function buildMetaPayloadPreview(
  launch: ResolvedMetaLaunchBody,
  campaignId = "META_CAMPAIGN_ID",
  creativeOptions: MetaLaunchPayloadOptions = {},
): JsonRecord {
  // Security-2A: the builder itself lives in ./meta-launch-payload so the Meta
  // safety invariants can be asserted without an HTTP request. This wrapper is
  // the only place that reads the environment for it, keeping that module pure.
  return buildMetaLaunchPayloadPreview(launch, campaignId, {
    ...creativeOptions,
    videoLaunchEnabled: isMetaVideoLaunchEnabled(),
  });
}

async function persistMetaLaunch(input: {
  workspaceId: string;
  payload: JsonRecord;
  compliance: JsonRecord;
  metaResponse: JsonRecord;
  status: string;
  metaStatus: string;
  lastError?: string;
}) {
  const config = configs["meta-launches"];
  const supabase = getSupabaseServerClient();
  const demoItem = config.demoItem({
    ...input.payload,
    workspaceId: input.workspaceId,
    status: input.status,
    metaStatus: input.metaStatus,
    compliance: input.compliance,
    metaResponse: input.metaResponse,
    lastError: input.lastError,
  });

  if (!supabase || !isUuid(input.workspaceId)) {
    return { mode: "demo" as CrmMode, item: demoItem };
  }

  const row = config.toRow(
    {
      ...input.payload,
      status: input.status,
      metaStatus: input.metaStatus,
      compliance: input.compliance,
      metaResponse: input.metaResponse,
      lastError: input.lastError,
    },
    input.workspaceId,
  );

  try {
    const { data, error } = await supabase.from(config.table).insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return { mode: "supabase" as CrmMode, item: config.fromRow(asRecord(data)) };
  } catch (error) {
    const warning = supabaseWarning(config.table, error);
    console.warn(warning);
    return { mode: "demo" as CrmMode, item: demoItem, warning };
  }
}

async function insertMetaAuditLog(input: {
  workspaceId: string;
  launchId: string;
  actorName: string;
  actorRole: string;
  action: string;
  details: JsonRecord;
}) {
  const supabase = getSupabaseServerClient();
  if (!supabase || !isUuid(input.workspaceId) || !isUuid(input.launchId)) return;

  try {
    const { error } = await supabase.from("meta_launch_audit_logs").insert({
      workspace_id: input.workspaceId,
      launch_id: input.launchId,
      actor_name: input.actorName || null,
      actor_role: input.actorRole || null,
      action: input.action,
      details: input.details,
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    console.warn(supabaseWarning("meta_launch_audit_logs", error));
  }
}

function extractMetaIds(metaResponse: JsonRecord) {
  return {
    metaCampaignId: firstString(metaResponse.metaCampaignId, asRecord(metaResponse.campaign).id),
    metaAdSetId: firstString(metaResponse.metaAdSetId, asRecord(metaResponse.adSet).id),
    metaCreativeId: firstString(metaResponse.metaCreativeId, asRecord(metaResponse.creative).id),
    metaAdId: firstString(metaResponse.metaAdId, asRecord(metaResponse.ad).id),
    metaVideoId: firstString(metaResponse.videoId, metaResponse.metaVideoId),
  };
}

function sanitizeLaunchPayload(body: JsonRecord): JsonRecord {
  const sensitive = new Set([
    "token",
    "accesstoken",
    "access_token",
    "metaaccesstoken",
    "meta_access_token",
    "metaappsecret",
    "meta_app_secret",
    "appsecret",
    "app_secret",
  ]);

  return Object.fromEntries(
    Object.entries(body).filter(([key, value]) => value !== undefined && !sensitive.has(key.toLowerCase().replace(/[^a-z_]/g, ""))),
  );
}

export async function handleMetaValidate(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use POST"]));
  }

  const body = asRecord(req.body);
  const config = getMetaConfig();
  if (readBoolean(body.dryRun)) {
    return sendJson(
      res,
      200,
      success("demo", {
        configured: config.configured,
        dryRun: true,
        adAccountId: config.adAccountId,
        pageId: config.pageId,
        instagramActorId: config.instagramActorId,
        astanaCityKeyConfigured: Boolean(readEnvValue("META_ASTANA_CITY_KEY")),
        cityResolver: {
          staticCities: KZ_META_CITY_OPTIONS.map((city) => city.id),
          cache: "memory",
          targetingSearch: Boolean(config.accessToken),
        },
        instagramActor: {
          configured: Boolean(config.instagramActorId),
          valid: "not_checked",
        },
        hasAccessToken: Boolean(config.accessToken),
      }),
    );
  }

  if (!config.configured) {
    return sendJson(
      res,
      200,
      success("demo", {
        configured: false,
        adAccountId: config.adAccountId,
        pageId: config.pageId,
        instagramActorId: config.instagramActorId,
        astanaCityKeyConfigured: Boolean(readEnvValue("META_ASTANA_CITY_KEY")),
        cityResolver: {
          staticCities: KZ_META_CITY_OPTIONS.map((city) => city.id),
          cache: "memory",
          targetingSearch: Boolean(config.accessToken),
        },
        instagramActor: {
          configured: Boolean(config.instagramActorId),
          valid: false,
          warning: config.instagramActorId ? "Meta env не настроены полностью, Instagram actor не проверялся." : "",
        },
        hasAccessToken: Boolean(config.accessToken),
      }, "Meta env не настроены."),
    );
  }

  try {
    const account = await checkMetaAdAccount();
    const defaultCityTargeting = await resolveMetaTargetingForCity(getKzMetaCityOption("astana"));
    let instagramActor: JsonRecord = {
      configured: Boolean(config.instagramActorId),
      valid: !config.instagramActorId,
      warning: config.instagramActorId ? "" : "Instagram actor ID не задан. Фото-реклама будет запускаться через Facebook Page.",
    };
    let instagramWarning = "";

    if (config.instagramActorId) {
      try {
        const actor = await checkMetaInstagramActor();
        instagramActor = {
          configured: true,
          valid: true,
          id: firstString(actor.id, config.instagramActorId),
          username: firstString(actor.username, actor.name),
        };
      } catch {
        instagramWarning = "Instagram actor ID невалиден или недоступен. Фото-реклама может запускаться через Facebook Page.";
        instagramActor = {
          configured: true,
          valid: false,
          id: config.instagramActorId,
          warning: instagramWarning,
        };
      }
    }

    return sendJson(
      res,
      200,
      success("supabase", {
        configured: true,
        account,
        adAccountId: config.adAccountId,
        pageId: config.pageId,
        instagramActorId: config.instagramActorId,
        astanaCityKeyConfigured: Boolean(readEnvValue("META_ASTANA_CITY_KEY")),
        astanaTargeting: defaultCityTargeting,
        defaultCityTargeting,
        cityResolver: {
          staticCities: KZ_META_CITY_OPTIONS.map((city) => city.id),
          cache: "memory",
          targetingSearch: true,
        },
        instagramActor,
        hasAccessToken: true,
      }, instagramWarning || undefined),
    );
  } catch (error) {
    return sendJson(res, 502, {
      ...errorBody("Не удалось проверить Meta", [error instanceof Error ? error.message : "Meta API не ответил на проверку."]),
      status: 502,
    });
  }
}

export async function handleMetaStatus(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use GET"]));
  }

  const campaignId = readQueryString(req.query.campaignId ?? req.query.campaign_id);
  if (!campaignId) {
    return sendJson(res, 400, errorBody("Validation error", ["campaignId is required"]));
  }

  if (campaignId.startsWith("dryrun_") || campaignId.startsWith("demo")) {
    return sendJson(
      res,
      200,
      success("demo", {
        campaignId,
        status: "PAUSED",
        effectiveStatus: "PAUSED",
        checkedAt: new Date().toISOString(),
      }),
    );
  }

  if (!getMetaConfig().configured) {
    return sendJson(
      res,
      200,
      success("demo", {
        campaignId,
        status: "unknown",
        effectiveStatus: "unknown",
        checkedAt: new Date().toISOString(),
      }, "Meta env не настроены."),
    );
  }

  try {
    const status = await getMetaCampaignStatus(campaignId);
    return sendJson(res, 200, success("supabase", { campaignId, status, checkedAt: new Date().toISOString() }));
  } catch (error) {
    return sendJson(res, 502, {
      ...errorBody("Не удалось проверить статус Meta", [error instanceof Error ? error.message : "Meta API не вернул статус."]),
      status: 502,
    });
  }
}

export async function handleMetaCityKey(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use GET or POST"]));
  }

  const body = asRecord(req.body);
  const city = firstString(body.city, body.selectedCityId, readQueryString(req.query.city), readQueryString(req.query.selectedCityId), "astana");
  if (!city.trim()) {
    return sendJson(res, 400, errorBody("Validation error", ["city is required"]));
  }

  const cityOption = getKzMetaCityOption(city);
  const target = await resolveMetaCityTarget(cityOption);
  const configured = getMetaConfig().configured;
  const selected = target.selected || null;
  const candidates: MetaCitySearchCandidate[] = target.candidates || [];
  const rejectedCandidates: MetaCitySearchCandidate[] = target.rejectedCandidates || [];

  return sendJson(
    res,
    200,
    success(configured ? "supabase" : "demo", {
      city: cityOption.labelRu,
      cityId: cityOption.id,
      labelRu: cityOption.labelRu,
      canonicalName: cityOption.canonicalName,
      key: target.key,
      name: target.name || cityOption.canonicalName,
      country_code: target.countryCode || "KZ",
      countryCode: target.countryCode || "KZ",
      region: target.region || "",
      source: target.source,
      selected,
      candidates,
      rejectedCandidates,
      warning: target.warning || "",
      geoMode: target.key ? "city" : "country",
      fallbackCountry: !target.key,
      targetingSearchAvailable: configured,
    }, target.warning),
  );
}

export async function handleMetaLaunch(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use POST"]));
  }

  const body = asRecord(req.body);
  const workspaceId = readWorkspaceId(req, body);
  const launch = buildMetaLaunchBody(body);
  const actorName = firstString(body.launchedBy, body.actorName, body.userName);
  const actorRole = firstString(body.launchedByRole, body.actorRole, "owner");
  const dryRun = readBoolean(body.dryRun);
  const details: string[] = [];

  if (!launch.campaignName) details.push("Название кампании обязательно.");
  if (!launch.selectedCityValid) details.push("Выберите город из списка Казахстана. Свободный ввод города для Meta launch отключён.");
  if (!launch.primaryText) details.push("Текст объявления обязателен.");
  if (!launch.headline) details.push("Заголовок обязателен.");
  if (!launch.dailyBudget || launch.dailyBudgetMinor <= 0) details.push("Укажите дневной бюджет больше 0.");
  if (!launch.landingUrl) details.push("Укажите, куда должны приходить заявки.");
  if (!launch.imageUrl && !launch.creativeUrl && !launch.videoUrl) details.push("Креатив загружен, но публичная ссылка не получена.");
  if (launch.creativeType === "video" && !launch.videoId && !launch.videoUrl) {
    details.push("Для видео нужен Meta video_id или публичная ссылка для загрузки в Meta.");
  }
  if (!dryRun && launch.creativeType === "video" && !isMetaVideoLaunchEnabled()) {
    details.push(META_VIDEO_LAUNCH_DISABLED_MESSAGE);
  }
  if (!dryRun && launch.creativeType === "video" && isMetaVideoLaunchEnabled() && !launch.videoId && !isSupportedMetaVideoFormat({ fileName: launch.fileName, mimeType: launch.mimeType })) {
    details.push(META_VIDEO_FORMAT_ERROR);
  }
  // Meta requires a real image thumbnail in video_data.image_url; the video URL itself does not count.
  const videoThumbnailUrl = launch.creativeType === "video"
    ? resolveVideoThumbnailUrl({ thumbnailUrl: launch.thumbnailUrl, videoUrl: launch.videoUrl || launch.creativeUrl })
    : "";
  if (!dryRun && launch.creativeType === "video" && isMetaVideoLaunchEnabled() && !videoThumbnailUrl) {
    details.push(META_VIDEO_THUMBNAIL_REQUIRED_MESSAGE);
  }
  if (!readBoolean(body.complianceConfirmed)) details.push("Подтвердите проверку безопасности текста.");
  if (!readBoolean(body.manualApprovalConfirmed)) details.push("Подтвердите ручное согласование запуска.");

  const budgetOverrideConfirmed = readBoolean(body.budgetOverrideConfirmed);
  if (launch.dailyBudget > META_MAX_DAILY_BUDGET && (!budgetOverrideConfirmed || !roleCanLaunchActive(actorRole))) {
    details.push(`Дневной бюджет больше ${META_MAX_DAILY_BUDGET} ${launch.currency}; нужен owner/admin override.`);
  }
  if (launch.totalBudget > META_MAX_TOTAL_BUDGET && (!budgetOverrideConfirmed || !roleCanLaunchActive(actorRole))) {
    details.push(`Общий бюджет больше ${META_MAX_TOTAL_BUDGET} ${launch.currency}; нужен owner/admin override.`);
  }

  const liveLaunchEnabled = await readMetaLiveLaunchEnabled(workspaceId, body);
  if (launch.statusMode === "ACTIVE") {
    if (!liveLaunchEnabled) details.push("ACTIVE запуск выключен в Admin Center.");
    if (!roleCanLaunchActive(actorRole)) details.push("ACTIVE запуск доступен только owner/admin.");
    if (readString(body.activeConfirmation).toUpperCase() !== "ЗАПУСТИТЬ") details.push("Для ACTIVE введите ЗАПУСТИТЬ");
  }

  const compliance = checkMetaCompliance({
    headline: launch.headline,
    text: launch.primaryText,
    description: launch.description,
  });
  if (compliance.status === "blocked") {
    return sendJson(res, 400, {
      ...errorBody("Проверка безопасности заблокировала текст", ["Перепишите текст перед запуском."]),
      data: { compliance, safeText: compliance.safeText },
    });
  }
  if (compliance.status === "needs_review" && !readBoolean(body.manualApprovalConfirmed)) {
    details.push("Нужно ручное согласование текста со статусом needs_review.");
  }

  if (details.length > 0) {
    return sendJson(res, 400, {
      ...errorBody("Validation error", details),
      data: { compliance, safeText: compliance.safeText },
    });
  }

  const selectedCity = getKzMetaCityOption(launch.selectedCityId || launch.city);
  const targetingResolution = await resolveMetaTargetingForCity(selectedCity, launch.metaCityKey || launch.astanaCityKey);
  const resolvedLaunch = { ...launch, targetingResolution };
  if (!dryRun && (!targetingResolution.cityKey || targetingResolution.fallbackCountry)) {
    const cityName = targetingResolution.labelRu || selectedCity.labelRu || resolvedLaunch.city;
    return sendJson(res, 400, {
      ...errorBody("Validation error", [
        `Meta city key для города ${cityName} не найден. Запуск остановлен, чтобы не запустить рекламу на весь Казахстан. Проверьте город в Admin → Meta/Facebook Ads → Проверить Meta city key.`,
      ]),
      data: {
        targetingResolution,
        selectedCity: {
          id: selectedCity.id,
          labelRu: selectedCity.labelRu,
          canonicalName: selectedCity.canonicalName,
        },
      },
    });
  }

  const payload: JsonRecord = {
    workspaceId,
    launchedBy: actorName,
    launchedByRole: actorRole,
    sourceModule: firstString(body.sourceModule, body.source_module, "ads-automation"),
    sourceId: firstString(body.sourceId, body.source_id),
    campaignName: resolvedLaunch.campaignName,
    objective: resolvedLaunch.objective,
    status: resolvedLaunch.statusMode === "ACTIVE" ? "active" : "paused",
    budgetDailyMinor: resolvedLaunch.dailyBudgetMinor,
    budgetTotalMinor: resolvedLaunch.totalBudgetMinor,
    currency: resolvedLaunch.currency,
    startTime: resolvedLaunch.startDate,
    endTime: resolvedLaunch.endDate,
    pageId: resolvedLaunch.pageId,
    instagramActorId: resolvedLaunch.instagramActorId,
    adAccountId: resolvedLaunch.adAccountId,
    launchTimestamp: resolvedLaunch.launchTimestamp,
    adSetName: resolvedLaunch.adSetName,
    creativeName: resolvedLaunch.creativeName,
    adName: resolvedLaunch.adName,
    targeting: {
      cityInput: targetingResolution.cityInput || resolvedLaunch.city,
      selectedCity: {
        id: targetingResolution.cityId || selectedCity.id,
        labelRu: targetingResolution.labelRu || selectedCity.labelRu,
        canonicalName: targetingResolution.canonicalName || selectedCity.canonicalName,
      },
      cityId: targetingResolution.cityId || selectedCity.id,
      labelRu: targetingResolution.labelRu || selectedCity.labelRu,
      canonicalName: targetingResolution.canonicalName || selectedCity.canonicalName,
      cityKey: targetingResolution.cityKey || "",
      cityKeySource: targetingResolution.cityKeySource || targetingResolution.source,
      selected: targetingResolution.selected || null,
      candidates: targetingResolution.candidates || [],
      rejectedCandidates: targetingResolution.rejectedCandidates || [],
      geoMode: targetingResolution.geoMode,
      city: targetingResolution.city,
      radiusKm: targetingResolution.radiusKm,
      cityRadiusKm: "-",
      usesRadius: false,
      fallbackCountry: targetingResolution.fallbackCountry,
      source: targetingResolution.source,
      cityWarning: targetingResolution.warning || "",
      warning: targetingResolution.warning || "",
      placementsMode: "instagram_only",
      publisher_platforms: ["instagram"],
      instagram_positions: ["stream", "story", "explore", "reels"],
    },
    payload: {
      ...sanitizeLaunchPayload(body),
    },
    compliance,
  };

  const config = getMetaConfig();
  let metaPayload = buildMetaPayloadPreview(resolvedLaunch);
  let metaResponse: JsonRecord;
  let launchStatus = resolvedLaunch.statusMode === "ACTIVE" ? "active" : "paused";
  let warning = "";
  const targetingWarning = targetingResolution.warning || "";

  try {
    if (dryRun) {
      // Dry-run records must never look like real PAUSED launches in history.
      launchStatus = "dry_run";
      metaResponse = {
        dryRun: true,
        metaCampaignId: demoMetaId("campaign"),
        metaAdSetId: demoMetaId("adset"),
        metaCreativeId: demoMetaId("creative"),
        metaAdId: demoMetaId("ad"),
        payload: metaPayload,
      };
      warning = [
        "Проверка прошла без запуска: Meta API не вызывался.",
        targetingWarning,
        resolvedLaunch.creativeType === "video" && !videoThumbnailUrl ? META_VIDEO_THUMBNAIL_REQUIRED_MESSAGE : "",
      ]
        .filter(Boolean)
        .join(" ");
    } else {
      if (!config.configured) {
        throw new Error("Meta env is not configured");
      }
      const result = await launchMetaCampaign({
        campaignName: resolvedLaunch.campaignName,
        objective: resolvedLaunch.objective,
        status: resolvedLaunch.statusMode,
        dailyBudgetMinor: resolvedLaunch.dailyBudgetMinor,
        lifetimeBudgetMinor: resolvedLaunch.totalBudgetMinor,
        currency: resolvedLaunch.currency,
        primaryText: resolvedLaunch.primaryText,
        headline: resolvedLaunch.headline,
        description: resolvedLaunch.description,
        cta: resolvedLaunch.cta,
        landingUrl: resolvedLaunch.landingUrl,
        imageUrl: resolvedLaunch.creativeType === "image" ? resolvedLaunch.imageUrl || resolvedLaunch.creativeUrl : "",
        creativeType: resolvedLaunch.creativeType,
        fileName: resolvedLaunch.fileName,
        mimeType: resolvedLaunch.mimeType,
        fileSize: resolvedLaunch.fileSize,
        videoUrl: resolvedLaunch.creativeType === "video" ? resolvedLaunch.videoUrl || resolvedLaunch.creativeUrl : "",
        videoId: resolvedLaunch.creativeType === "video" ? resolvedLaunch.videoId : "",
        thumbnailUrl: resolvedLaunch.thumbnailUrl,
        instagramActorId: resolvedLaunch.instagramActorId,
        startTime: resolvedLaunch.startDate,
        endTime: resolvedLaunch.endDate || undefined,
        city: resolvedLaunch.city,
        selectedCityId: resolvedLaunch.selectedCityId,
        selectedCityLabelRu: resolvedLaunch.selectedCityLabelRu,
        selectedCityCanonicalName: resolvedLaunch.selectedCityCanonicalName,
        audienceLabel: resolvedLaunch.audienceLabel,
        launchTimestamp: resolvedLaunch.launchTimestamp,
        adSetName: resolvedLaunch.adSetName,
        creativeName: resolvedLaunch.creativeName,
        adName: resolvedLaunch.adName,
        metaCityKey: resolvedLaunch.metaCityKey,
        astanaCityKey: resolvedLaunch.astanaCityKey,
        targetingResolution,
      });
      warning = [result.warning, targetingWarning].filter(Boolean).join(" ") || warning;
      metaResponse = result;
      const realMetaPayload = buildMetaPayloadPreview(
        resolvedLaunch,
        firstString(result.metaCampaignId, asRecord(result.campaign).id, "META_CAMPAIGN_ID"),
        {
          usesInstagramActor: Boolean(result.creativeUsesInstagramActor),
          instagramActorFallback: Boolean(result.instagramActorFallback),
          imageUploadMode: result.imageUploadMode,
          imageHash: Boolean(result.imageHashReceived),
          pictureUrl: Boolean(result.pictureUrlUsed),
          imageUploadCapabilityFallback: Boolean(result.imageUploadCapabilityFallback),
          omitInstagramPositions: Boolean(result.instagramPositionsFallback),
          videoId: result.videoId,
          videoUploadMode: result.videoUploadMode,
          videoProcessingStatus: result.videoProcessingStatus,
          videoWarnings: result.videoWarnings,
        },
      );
      metaPayload = realMetaPayload;
      metaResponse = {
        ...metaResponse,
        payload: realMetaPayload,
      };
    }
  } catch (error) {
    // The video is accepted by Meta and still processing — no campaign exists yet,
    // and this must not be recorded or shown as a failed launch.
    if (isMetaVideoProcessingPendingError(error)) {
      const debug = asRecord(error.details.debug);
      const pendingVideoId = firstString(debug.videoId);
      const processingStatus = firstString(debug.status) || "processing";
      const lastCheckedAt = new Date().toISOString();
      const saved = await persistMetaLaunch({
        workspaceId,
        payload: {
          ...payload,
          metaVideoId: pendingVideoId,
          videoProcessingStatus: processingStatus,
          lastCheckedAt,
          payload: {
            ...asRecord(payload.payload),
            metaVideoId: pendingVideoId,
            videoProcessingStatus: processingStatus,
            lastCheckedAt,
          },
        },
        compliance: compliance as unknown as JsonRecord,
        metaResponse: {
          videoId: pendingVideoId,
          metaVideoId: pendingVideoId,
          videoProcessingStatus: processingStatus,
          pendingVideoProcessing: true,
          lastCheckedAt,
          payload: metaPayload,
        },
        status: "video_processing",
        metaStatus: "VIDEO_PROCESSING",
      });
      return sendJson(
        res,
        202,
        success(saved.mode, {
          launchId: firstString(asRecord(saved.item).id),
          launch: saved.item,
          compliance,
          safeText: compliance.safeText,
          dryRun: false,
          status: "video_processing",
          metaStatus: "VIDEO_PROCESSING",
          metaVideoId: pendingVideoId,
          videoId: pendingVideoId,
          videoProcessingStatus: processingStatus,
          lastCheckedAt,
          launchTimestamp: resolvedLaunch.launchTimestamp,
          metaPayload,
        }, META_VIDEO_PROCESSING_TIMEOUT_MESSAGE),
      );
    }

    const metaError = safeMetaLaunchError(error);
    const lastError = firstString(metaError.message, "Не удалось создать рекламу в Meta");
    const saved = await persistMetaLaunch({
      workspaceId,
      payload,
      compliance: compliance as unknown as JsonRecord,
      metaResponse: {
        error: metaError,
        payload: metaPayload,
      },
      status: "failed",
      metaStatus: "failed",
      lastError,
    });
    return sendJson(res, 502, {
      ...errorBody("Не удалось создать рекламу в Meta", [lastError]),
      mode: saved.mode,
      data: { launch: saved.item, compliance, safeText: compliance.safeText, metaError, metaPayload },
    });
  }

  const ids = extractMetaIds(metaResponse);
  const saved = await persistMetaLaunch({
    workspaceId,
    payload: {
      ...payload,
      ...ids,
      metaStatus: dryRun ? "DRY_RUN" : resolvedLaunch.statusMode,
    },
    compliance: compliance as unknown as JsonRecord,
    metaResponse,
    status: launchStatus,
    metaStatus: dryRun ? "DRY_RUN" : resolvedLaunch.statusMode,
  });

  const launchId = firstString(asRecord(saved.item).id);
  await insertMetaAuditLog({
    workspaceId,
    launchId,
    actorName,
    actorRole,
    action: dryRun ? "dry_run" : resolvedLaunch.statusMode === "ACTIVE" ? "launch_active" : "create_paused",
    details: {
      campaignName: resolvedLaunch.campaignName,
      statusMode: resolvedLaunch.statusMode,
      launchTimestamp: resolvedLaunch.launchTimestamp,
      dryRun,
      complianceStatus: compliance.status,
      targeting: payload.targeting,
    },
  });

  return sendJson(
    res,
    dryRun ? 200 : 201,
    success(saved.mode, {
      launchId,
      launch: saved.item,
      compliance,
      safeText: compliance.safeText,
      dryRun,
      warning: warning || saved.warning || "",
      launchTimestamp: resolvedLaunch.launchTimestamp,
      metaPayload,
      ...ids,
      status: launchStatus,
      metaStatus: resolvedLaunch.statusMode,
    }, saved.warning || warning || undefined),
  );
}

export async function handleCrmHealth(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use GET"]));
  }

  const supabase = getSupabaseServerClient();
  const providers = {
    supabase: {
      status: supabase ? "configured" : "not_configured",
      env: envStatus(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]),
    },
    adCreativesStorage: {
      status: supabase ? "checking" : "not_configured",
      env: envStatus(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]),
    },
    staffAuth: envStatus(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]),
    vercelBasic: envStatus(["TARGETING_AGENT_URL"]),
    telegram: envStatus(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]),
    targetingAgent: envStatus(["TARGETING_AGENT_URL"]),
    openai: singleEnvStatus("OPENAI_API_KEY"),
    anthropic: singleEnvStatus("ANTHROPIC_API_KEY"),
    gemini: singleEnvStatus("GEMINI_API_KEY"),
    elevenlabs: envStatus(["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"]),
    heygen: singleEnvStatus("HEYGEN_API_KEY"),
    tapnow: singleEnvStatus("TAPNOW_API_KEY"),
    meta: envStatus([
      "META_BUSINESS_ID",
      "META_APP_ID",
      "META_APP_SECRET",
      "META_ACCESS_TOKEN",
      "META_AD_ACCOUNT_ID",
      "META_PAGE_ID",
      "META_INSTAGRAM_ACTOR_ID",
    ]),
  };
  const safeMeta = {
    configured:
      Boolean(readEnvValue("META_BUSINESS_ID")) &&
      Boolean(readEnvValue("META_AD_ACCOUNT_ID")) &&
      Boolean(readEnvValue("META_PAGE_ID")) &&
      Boolean(readEnvValue("META_INSTAGRAM_ACTOR_ID")) &&
      Boolean(readEnvValue("META_ACCESS_TOKEN")) &&
      Boolean(readEnvValue("META_APP_SECRET")),
    // Presence only. These are the platform's Meta account identifiers; a
    // clinic administrator has no reason to read them, and a per-workspace
    // record already carries the clinic's own values.
    businessIdConfigured: Boolean(readEnvValue("META_BUSINESS_ID")),
    adAccountConfigured: Boolean(readEnvValue("META_AD_ACCOUNT_ID")),
    pageConfigured: Boolean(readEnvValue("META_PAGE_ID")),
    instagramActorConfigured: Boolean(readEnvValue("META_INSTAGRAM_ACTOR_ID")),
    astanaCityKeyConfigured: Boolean(readEnvValue("META_ASTANA_CITY_KEY")),
    cityResolver: {
      staticCities: KZ_META_CITY_OPTIONS.map((city) => city.id),
      cache: "memory",
      targetingSearchFallback: Boolean(readEnvValue("META_ACCESS_TOKEN")),
    },
    videoLaunchEnabled: isMetaVideoLaunchEnabled(),
    hasAccessToken: Boolean(readEnvValue("META_ACCESS_TOKEN")),
    hasAppSecret: Boolean(readEnvValue("META_APP_SECRET")),
    videoOptimization: videoOptimizationConfig(),
  };

  return sendJson(
    res,
    200,
    success(supabase ? "supabase" : "demo", {
      status: "ok",
      service: "negis-crm",
      generatedAt: new Date().toISOString(),
      providers,
      meta: safeMeta,
      secrets: "masked",
    }),
  );
}

type MetaInsightsLaunchContext = {
  launchId: string;
  metaCampaignId: string;
  adAccountId: string;
  currency: string;
  accountTimezone: string;
  attributionSetting: string;
};

const META_INSIGHTS_DEFAULT_TIMEZONE = "Asia/Almaty";
const META_INSIGHTS_MAX_RANGE_DAYS = 31;

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const value = `${values.year}-${values.month}-${values.day}`;
  if (!isIsoCalendarDate(value)) throw new Error("Invalid formatted date");
  return value;
}

function dateInTimeZone(timeZone: string): string {
  try {
    return formatDateInTimeZone(timeZone);
  } catch {
    // Invalid account timezone falls back to the product's Kazakhstan timezone.
  }

  return formatDateInTimeZone(META_INSIGHTS_DEFAULT_TIMEZONE);
}

function resolveMetaInsightsDateRange(
  input: JsonRecord,
  timeZone: string,
): { dateStart: string; dateStop: string } {
  const requestedStart = firstString(input.dateStart, input.date_start);
  const requestedStop = firstString(input.dateStop, input.date_stop);
  if (Boolean(requestedStart) !== Boolean(requestedStop)) {
    throw new MetaInsightsError("invalid_range", "Укажите обе даты периода Insights.");
  }

  const today = dateInTimeZone(timeZone);
  const dateStop = requestedStop || today;
  const dateStart = requestedStart || addCalendarDays(dateStop, -6);
  if (!isIsoCalendarDate(dateStart) || !isIsoCalendarDate(dateStop)) {
    throw new MetaInsightsError("invalid_range", "Период Insights должен быть в формате YYYY-MM-DD.");
  }
  if (dateStart > dateStop) {
    throw new MetaInsightsError("invalid_range", "Начало периода Insights не может быть позже окончания.");
  }
  if (dateStart > today || dateStop > today) {
    throw new MetaInsightsError("invalid_range", "Период Insights не может включать будущие даты.");
  }

  const start = new Date(`${dateStart}T00:00:00.000Z`).getTime();
  const stop = new Date(`${dateStop}T00:00:00.000Z`).getTime();
  const rangeDays = Math.floor((stop - start) / 86_400_000) + 1;
  if (rangeDays > META_INSIGHTS_MAX_RANGE_DAYS) {
    throw new MetaInsightsError("invalid_range", `Период Insights не может быть больше ${META_INSIGHTS_MAX_RANGE_DAYS} дней.`);
  }

  return { dateStart, dateStop };
}

function normalizeMetaAccountId(value: unknown): string {
  return readString(value).toLowerCase().replace(/^act_/, "");
}

function isRealMetaCampaignId(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^\d+$/.test(normalized) && !normalized.startsWith("0");
}

function launchUsesDryRun(launch: JsonRecord): boolean {
  const payload = asRecord(launch.payload);
  const sourcePayload = asRecord(payload.payload);
  const metaResponse = asRecord(launch.meta_response);
  return (
    readBoolean(payload.dryRun) ||
    readBoolean(payload.dry_run) ||
    readBoolean(sourcePayload.dryRun) ||
    readBoolean(sourcePayload.dry_run) ||
    readBoolean(metaResponse.dryRun) ||
    readString(launch.status).toLowerCase() === "dry_run" ||
    readString(launch.meta_status).toUpperCase() === "DRY_RUN"
  );
}

async function loadMetaInsightsLaunchContext(
  supabase: CrmSupabaseClient,
  workspaceId: string,
  launchId: string,
): Promise<MetaInsightsLaunchContext> {
  if (!isUuid(launchId)) {
    throw new MetaInsightsError("launch_not_eligible", "Выберите сохранённый запуск Meta.");
  }

  const { data, error } = await supabase
    .from("meta_campaign_launches")
    .select("id,workspace_id,status,meta_status,meta_campaign_id,ad_account_id,currency,payload,meta_response")
    .eq("id", launchId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) {
    throw new MetaInsightsError("persistence_failed", "Не удалось проверить запуск в Supabase.");
  }

  const launch = asRecord(data);
  if (!readString(launch.id)) {
    throw new MetaInsightsError("launch_not_eligible", "Запуск не найден в текущем workspace.");
  }

  const status = readString(launch.status).toLowerCase();
  const metaStatus = readString(launch.meta_status).toLowerCase();
  if ([status, metaStatus].some((value) => value === "failed" || value === "video_processing")) {
    throw new MetaInsightsError("launch_not_eligible", "Insights доступны только для завершённого реального запуска Meta.");
  }
  if (launchUsesDryRun(launch)) {
    throw new MetaInsightsError("launch_not_eligible", "Dry-run запуск не имеет фактических Meta Insights.");
  }

  const metaCampaignId = readString(launch.meta_campaign_id);
  if (!isRealMetaCampaignId(metaCampaignId)) {
    throw new MetaInsightsError("launch_not_eligible", "У запуска нет реального Meta campaign ID.");
  }

  const config = getMetaConfig();
  const launchAdAccountId = readString(launch.ad_account_id);
  const configuredAccount = normalizeMetaAccountId(config.adAccountId);
  const launchAccount = normalizeMetaAccountId(launchAdAccountId);
  if (configuredAccount && launchAccount && configuredAccount !== launchAccount) {
    throw new MetaInsightsError("launch_not_eligible", "Запуск относится к другому Meta ad account.");
  }

  const { data: accountRows, error: accountError } = await supabase
    .from("meta_ad_accounts")
    .select("ad_account_id,currency,timezone_name,metadata")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(20);
  if (accountError) {
    throw new MetaInsightsError("persistence_failed", "Не удалось проверить настройки Meta account в Supabase.");
  }

  const preferredAccount = configuredAccount || launchAccount;
  const accounts = (Array.isArray(accountRows) ? accountRows : []).map((row) => asRecord(row));
  const account =
    accounts.find((row) => normalizeMetaAccountId(row.ad_account_id) === preferredAccount) ||
    accounts[0] ||
    {};
  const metadata = asRecord(account.metadata);

  return {
    launchId: readString(launch.id),
    metaCampaignId,
    adAccountId: launchAdAccountId || config.adAccountId,
    currency: firstString(account.currency, launch.currency),
    accountTimezone: firstString(account.timezone_name, metadata.timezoneName, metadata.timezone_name, META_INSIGHTS_DEFAULT_TIMEZONE),
    attributionSetting: firstString(metadata.attributionSetting, metadata.attribution_setting),
  };
}

function normalizedInsightToDatabaseRow(row: NormalizedMetaInsightRow): JsonRecord {
  return {
    workspace_id: row.workspaceId,
    meta_campaign_launch_id: row.metaCampaignLaunchId,
    meta_campaign_id: row.metaCampaignId,
    ad_account_id: row.adAccountId,
    date_start: row.dateStart,
    date_stop: row.dateStop,
    spend_minor: row.spendMinor,
    currency: row.currency,
    currency_exponent: row.currencyExponent,
    impressions: row.impressions,
    reach: row.reach,
    clicks: row.clicks,
    inline_link_clicks: row.inlineLinkClicks,
    meta_leads: row.metaLeads,
    action_counts: row.actionCounts,
    api_version: row.apiVersion,
    account_timezone: row.accountTimezone,
    attribution_setting: row.attributionSetting,
    fetched_at: row.fetchedAt,
    updated_at: new Date().toISOString(),
  };
}

function databaseIntegerString(value: unknown, fallback = "0"): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return fallback;
}

function mapMetaCampaignInsight(rowValue: unknown): JsonRecord {
  const row = asRecord(rowValue);
  return {
    id: readString(row.id),
    workspaceId: readString(row.workspace_id),
    metaCampaignLaunchId: readString(row.meta_campaign_launch_id),
    metaCampaignId: readString(row.meta_campaign_id),
    dateStart: readString(row.date_start),
    dateStop: readString(row.date_stop),
    spendMinor: databaseIntegerString(row.spend_minor),
    currency: readString(row.currency),
    impressions: databaseIntegerString(row.impressions),
    reach: databaseIntegerString(row.reach),
    clicks: databaseIntegerString(row.clicks),
    inlineLinkClicks: databaseIntegerString(row.inline_link_clicks),
    metaLeads: row.meta_leads === null || row.meta_leads === undefined ? null : databaseIntegerString(row.meta_leads),
    actionCounts: asRecord(row.action_counts),
    fetchedAt: firstString(row.fetched_at, row.updated_at),
  };
}

function mapMetaInsightsSyncRun(rowValue: unknown): JsonRecord {
  const row = asRecord(rowValue);
  return {
    id: readString(row.id),
    workspaceId: readString(row.workspace_id),
    metaCampaignLaunchId: firstString(row.meta_campaign_launch_id) || null,
    status: readString(row.status),
    dateStart: firstString(row.date_start) || null,
    dateStop: firstString(row.date_stop) || null,
    rowsUpserted: readNumber(row.rows_upserted) ?? 0,
    errorCode: firstString(row.error_code) || null,
    errorMessage: firstString(row.error_message) || null,
    startedAt: firstString(row.started_at) || null,
    finishedAt: firstString(row.finished_at) || null,
    createdAt: firstString(row.created_at) || null,
  };
}

type MetaInsightsHistoryAvailability = "available" | "not_synced" | "empty" | "running" | "failed" | "unavailable";

type MetaInsightsHistoryAggregate = {
  coveredDateStart: string | null;
  coveredDateStop: string | null;
  latestFetchedAt: string | null;
  latestFetchedTimestamp: number;
  rowCount: number;
  spendByCurrency: Map<string, { currency: string; currencyExponent: number; spendMinor: bigint }>;
  impressions: bigint;
  clicks: bigint;
  inlineLinkClicks: bigint;
  metaLeads: bigint;
  hasMetaLeads: boolean;
};

const META_INSIGHTS_HISTORY_LAUNCH_LIMIT = 40;
const META_INSIGHTS_HISTORY_PAGE_SIZE = 500;
const META_INSIGHTS_HISTORY_MAX_ROWS = 20_000;
const META_INSIGHTS_HISTORY_RUN_BATCH_SIZE = 8;

function isMetaInsightsHistoryLaunchEligible(launch: JsonRecord): boolean {
  const status = readString(launch.status).toLowerCase();
  const metaStatus = readString(launch.meta_status).toLowerCase();
  return (
    isUuid(readString(launch.id)) &&
    isRealMetaCampaignId(readString(launch.meta_campaign_id)) &&
    !launchUsesDryRun(launch) &&
    ![status, metaStatus].some((value) => value === "failed" || value === "video_processing")
  );
}

function strictDatabaseIntegerString(value: unknown, fieldName: string): string {
  const normalized = databaseIntegerString(value, "");
  if (!normalized) {
    throw new MetaInsightsError("persistence_failed", `Сохранённое поле ${fieldName} имеет некорректный формат.`);
  }
  return normalized;
}

function emptyMetaInsightsHistoryAggregate(): MetaInsightsHistoryAggregate {
  return {
    coveredDateStart: null,
    coveredDateStop: null,
    latestFetchedAt: null,
    latestFetchedTimestamp: Number.NEGATIVE_INFINITY,
    rowCount: 0,
    spendByCurrency: new Map(),
    impressions: 0n,
    clicks: 0n,
    inlineLinkClicks: 0n,
    metaLeads: 0n,
    hasMetaLeads: false,
  };
}

function aggregateMetaInsightsHistoryRow(
  aggregate: MetaInsightsHistoryAggregate,
  row: JsonRecord,
  expectedMetaCampaignId: string,
) {
  const rowMetaCampaignId = readString(row.meta_campaign_id);
  if (rowMetaCampaignId !== expectedMetaCampaignId) {
    throw new MetaInsightsError("persistence_failed", "Сохранённые Insights не совпали с исходным Meta launch.");
  }

  const currency = readString(row.currency).toUpperCase();
  const currencyExponent = readNumber(row.currency_exponent);
  if (!currency || currencyExponent === null || !Number.isInteger(currencyExponent) || currencyExponent < 0 || currencyExponent > 6) {
    throw new MetaInsightsError("persistence_failed", "Сохранённая валюта Insights имеет некорректный формат.");
  }

  const spendMinor = BigInt(strictDatabaseIntegerString(row.spend_minor, "spend_minor"));
  const currencyKey = `${currency}:${currencyExponent}`;
  const currentSpend = aggregate.spendByCurrency.get(currencyKey);
  aggregate.spendByCurrency.set(currencyKey, {
    currency,
    currencyExponent,
    spendMinor: (currentSpend?.spendMinor || 0n) + spendMinor,
  });

  aggregate.impressions += BigInt(strictDatabaseIntegerString(row.impressions, "impressions"));
  aggregate.clicks += BigInt(strictDatabaseIntegerString(row.clicks, "clicks"));
  aggregate.inlineLinkClicks += BigInt(strictDatabaseIntegerString(row.inline_link_clicks, "inline_link_clicks"));
  if (row.meta_leads !== null && row.meta_leads !== undefined) {
    aggregate.metaLeads += BigInt(strictDatabaseIntegerString(row.meta_leads, "meta_leads"));
    aggregate.hasMetaLeads = true;
  }

  const dateStart = readString(row.date_start);
  const dateStop = readString(row.date_stop);
  aggregate.coveredDateStart = !aggregate.coveredDateStart || dateStart < aggregate.coveredDateStart ? dateStart : aggregate.coveredDateStart;
  aggregate.coveredDateStop = !aggregate.coveredDateStop || dateStop > aggregate.coveredDateStop ? dateStop : aggregate.coveredDateStop;

  const fetchedAt = readString(row.fetched_at);
  const fetchedTimestamp = Date.parse(fetchedAt);
  if (Number.isFinite(fetchedTimestamp) && fetchedTimestamp > aggregate.latestFetchedTimestamp) {
    aggregate.latestFetchedTimestamp = fetchedTimestamp;
    aggregate.latestFetchedAt = fetchedAt;
  }
  aggregate.rowCount += 1;
}

async function loadLatestMetaInsightsRunsByLaunch(
  supabase: CrmSupabaseClient,
  workspaceId: string,
  launchIds: string[],
): Promise<Map<string, JsonRecord>> {
  const latestRuns = new Map<string, JsonRecord>();

  for (let offset = 0; offset < launchIds.length; offset += META_INSIGHTS_HISTORY_RUN_BATCH_SIZE) {
    const batch = launchIds.slice(offset, offset + META_INSIGHTS_HISTORY_RUN_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (launchId) => {
        const { data, error } = await supabase
          .from("meta_insights_sync_runs")
          .select("id,meta_campaign_launch_id,status,date_start,date_stop,rows_upserted,error_message,started_at,finished_at,created_at")
          .eq("workspace_id", workspaceId)
          .eq("meta_campaign_launch_id", launchId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) {
          throw new MetaInsightsError("persistence_failed", "Не удалось прочитать последний статус синхронизации Insights.");
        }
        return { launchId, run: asRecord(data) };
      }),
    );

    for (const result of results) {
      if (readString(result.run.id)) latestRuns.set(result.launchId, result.run);
    }
  }

  return latestRuns;
}

async function loadMetaInsightsHistoryRows(
  supabase: CrmSupabaseClient,
  workspaceId: string,
  launchIds: string[],
): Promise<JsonRecord[]> {
  if (launchIds.length === 0) return [];

  const { count, error: countError } = await supabase
    .from("meta_campaign_insights")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("meta_campaign_launch_id", launchIds);
  if (countError) {
    throw new MetaInsightsError("persistence_failed", "Не удалось проверить объём сохранённых Meta Insights.");
  }
  const rowCount = count || 0;
  if (rowCount > META_INSIGHTS_HISTORY_MAX_ROWS) {
    throw new MetaInsightsError("persistence_failed", "Сводка Meta Insights превышает безопасный лимит строк.");
  }

  const rows: JsonRecord[] = [];
  for (let offset = 0; offset < rowCount; offset += META_INSIGHTS_HISTORY_PAGE_SIZE) {
    const pageStop = Math.min(offset + META_INSIGHTS_HISTORY_PAGE_SIZE - 1, rowCount - 1);
    const { data, error } = await supabase
      .from("meta_campaign_insights")
      .select("id,meta_campaign_launch_id,meta_campaign_id,date_start,date_stop,spend_minor,currency,currency_exponent,impressions,clicks,inline_link_clicks,meta_leads,fetched_at")
      .eq("workspace_id", workspaceId)
      .in("meta_campaign_launch_id", launchIds)
      .order("date_start", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, pageStop);
    if (error) {
      throw new MetaInsightsError("persistence_failed", "Не удалось прочитать сохранённые Meta Insights.");
    }
    rows.push(...(Array.isArray(data) ? data.map(asRecord) : []));
  }

  if (rows.length !== rowCount) {
    throw new MetaInsightsError("persistence_failed", "Сохранённые Meta Insights изменились во время построения сводки.");
  }
  return rows;
}

function mapMetaInsightsHistoryLastRun(run: JsonRecord | undefined): JsonRecord | null {
  if (!run || !readString(run.id)) return null;
  return {
    status: readString(run.status),
    dateStart: firstString(run.date_start) || null,
    dateStop: firstString(run.date_stop) || null,
    rowsUpserted: readNumber(run.rows_upserted) ?? 0,
    startedAt: firstString(run.started_at) || null,
    finishedAt: firstString(run.finished_at) || null,
    safeErrorMessage: firstString(run.error_message) || null,
  };
}

function resolveMetaInsightsHistoryAvailability(input: {
  eligible: boolean;
  aggregate?: MetaInsightsHistoryAggregate;
  latestRun?: JsonRecord;
}): MetaInsightsHistoryAvailability {
  if (!input.eligible) return "unavailable";
  if (input.aggregate && input.aggregate.rowCount > 0) return "available";

  const runStatus = readString(input.latestRun?.status).toLowerCase();
  if (runStatus === "pending" || runStatus === "running") return "running";
  if (runStatus === "failed") return "failed";
  if (runStatus === "succeeded" && (readNumber(input.latestRun?.rows_upserted) ?? 0) === 0) return "empty";
  if (runStatus === "succeeded") return "failed";
  return "not_synced";
}

function asSafeMetaInsightsError(error: unknown): MetaInsightsError {
  if (
    error instanceof MetaInsightsError &&
    META_INSIGHTS_SAFE_ERROR_CODES.includes(error.code as MetaInsightsSafeErrorCode)
  ) {
    return error;
  }
  return new MetaInsightsError("sync_timeout", "Синхронизация Meta Insights не завершилась.");
}

function metaInsightsErrorStatus(error: MetaInsightsError): number {
  if (error.code === "invalid_range") return 400;
  if (error.code === "launch_not_eligible") return 422;
  if (error.code === "meta_rate_limited") return 429;
  if (error.code === "persistence_failed") return 503;
  if (error.code === "sync_timeout") return 504;
  return 502;
}

function sendMetaInsightsFailure(
  res: VercelResponse,
  error: MetaInsightsError,
  runId?: string,
) {
  return sendJson(res, metaInsightsErrorStatus(error), {
    ...errorBody("Meta Insights request failed", [error.message]),
    code: error.code,
    ...(runId ? { data: { runId, status: "failed" } } : {}),
  });
}

function sendWorkspaceAdminAuthError(res: VercelResponse, error: unknown) {
  if (error instanceof WorkspaceAdminAuthError) {
    return sendJson(res, error.statusCode, errorBody(error.message));
  }
  return sendJson(res, 503, errorBody("Authorization service unavailable"));
}

// CRM11e.2 shared sync core.
//
// The manual admin endpoint and the background worker cycle both drive the same
// Meta Insights sync so normalization and pagination are never duplicated. The
// core owns only the sync run lifecycle and the daily upsert. Scheduler-state
// lifecycle (lease, backoff, completeness, cadence) is owned by the background
// cycle handler; the manual endpoint does not touch scheduler state.

type MetaInsightsSyncTrigger = "manual" | "background";
type MetaInsightsSyncAuthMode = "user_admin" | "worker_hmac";

type SyncMetaInsightsForLaunchParams = {
  supabase: CrmSupabaseClient;
  workspaceId: string;
  metaCampaignLaunchId: string;
  dateStart?: string;
  dateStop?: string;
  trigger: MetaInsightsSyncTrigger;
  authMode: MetaInsightsSyncAuthMode;
  requestKey?: string;
};

type MetaInsightsSyncOutcome = {
  runId: string | null;
  status: "succeeded" | "failed" | "already_processed";
  rowsUpserted: number;
  pagesFetched: number;
  coverageComplete: boolean;
  empty: boolean;
  dateStart: string | null;
  dateStop: string | null;
  accountTimezone: string | null;
  timezoneFallback: boolean;
  finishedAt: string | null;
  error: MetaInsightsError | null;
  run: JsonRecord | null;
};

const META_INSIGHTS_BACKGROUND_LOOKBACK_DAYS = 3;
const META_INSIGHTS_BACKGROUND_LEASE_SECONDS = 120;
const META_INSIGHTS_BACKGROUND_MAX_LAUNCHES_DEFAULT = 2;
const META_INSIGHTS_BACKGROUND_MAX_LAUNCHES_ABSOLUTE = 10;
const META_INSIGHTS_BACKGROUND_FRESHNESS_SLA_HOURS = 36;
const META_INSIGHTS_BACKGROUND_PAUSED_NEXT_SYNC_HOURS = 24;

function asSafeMetaInsightsErrorCode(value: unknown): MetaInsightsSafeErrorCode {
  const code = readString(value);
  return META_INSIGHTS_SAFE_ERROR_CODES.includes(code as MetaInsightsSafeErrorCode)
    ? (code as MetaInsightsSafeErrorCode)
    : "sync_timeout";
}

function isUniqueViolationError(error: unknown): boolean {
  return readString(asRecord(error).code) === "23505";
}

// Background canary date policy: only completed account-local days. Today is
// always excluded; the default lookback is the previous 3 completed days. When
// the account timezone is unavailable the product timezone is used and the
// caller is told so it can mark completeness as partial rather than current.
function resolveBackgroundInsightsDateRange(timeZone: string): {
  dateStart: string;
  dateStop: string;
  timezoneFallback: boolean;
} {
  let today: string;
  let timezoneFallback = false;
  try {
    today = formatDateInTimeZone(timeZone);
  } catch {
    today = formatDateInTimeZone(META_INSIGHTS_DEFAULT_TIMEZONE);
    timezoneFallback = true;
  }
  const dateStop = addCalendarDays(today, -1);
  const dateStart = addCalendarDays(dateStop, -(META_INSIGHTS_BACKGROUND_LOOKBACK_DAYS - 1));
  return { dateStart, dateStop, timezoneFallback };
}

async function syncMetaInsightsForLaunch(
  params: SyncMetaInsightsForLaunchParams,
): Promise<MetaInsightsSyncOutcome> {
  const { supabase, workspaceId, trigger, requestKey } = params;

  const fail = (error: MetaInsightsError, runId: string | null): MetaInsightsSyncOutcome => ({
    runId,
    status: "failed",
    rowsUpserted: 0,
    pagesFetched: 0,
    coverageComplete: false,
    empty: false,
    dateStart: null,
    dateStop: null,
    accountTimezone: null,
    timezoneFallback: false,
    finishedAt: new Date().toISOString(),
    error,
    run: null,
  });

  // Replay protection: a background cycle keys each launch by a unique
  // request_key. If a run for that key already exists, return its safe summary
  // without starting a duplicate sync run.
  if (requestKey) {
    const { data: existingRunValue } = await supabase
      .from("meta_insights_sync_runs")
      .select("id,status,rows_upserted,pages_fetched,coverage_complete,date_start,date_stop,error_code")
      .eq("workspace_id", workspaceId)
      .eq("request_key", requestKey)
      .maybeSingle();
    const existing = asRecord(existingRunValue);
    if (readString(existing.id)) {
      const rows = readNumber(existing.rows_upserted) ?? 0;
      const existingCode = readString(existing.error_code);
      return {
        runId: readString(existing.id),
        status: "already_processed",
        rowsUpserted: rows,
        pagesFetched: readNumber(existing.pages_fetched) ?? 0,
        coverageComplete: readBoolean(existing.coverage_complete),
        empty: rows === 0,
        dateStart: firstString(existing.date_start) || null,
        dateStop: firstString(existing.date_stop) || null,
        accountTimezone: null,
        timezoneFallback: false,
        finishedAt: null,
        error: existingCode
          ? new MetaInsightsError(asSafeMetaInsightsErrorCode(existingCode), "Синхронизация уже была обработана.")
          : null,
        run: null,
      };
    }
  }

  let launchContext: MetaInsightsLaunchContext;
  let dateRange: { dateStart: string; dateStop: string };
  let timezoneFallback = false;
  try {
    launchContext = await loadMetaInsightsLaunchContext(supabase, workspaceId, params.metaCampaignLaunchId);
    if (trigger === "background") {
      const resolved = resolveBackgroundInsightsDateRange(launchContext.accountTimezone);
      dateRange = { dateStart: resolved.dateStart, dateStop: resolved.dateStop };
      timezoneFallback = resolved.timezoneFallback;
    } else {
      dateRange = resolveMetaInsightsDateRange(
        { dateStart: params.dateStart, dateStop: params.dateStop },
        launchContext.accountTimezone,
      );
    }
  } catch (error) {
    return fail(asSafeMetaInsightsError(error), null);
  }

  const createdAt = new Date().toISOString();
  const { data: pendingRunValue, error: pendingRunError } = await supabase
    .from("meta_insights_sync_runs")
    .insert({
      workspace_id: workspaceId,
      meta_campaign_launch_id: launchContext.launchId,
      sync_scope: "campaign",
      status: "pending",
      trigger,
      attempt: 1,
      pages_fetched: 0,
      coverage_complete: false,
      heartbeat_at: createdAt,
      date_start: dateRange.dateStart,
      date_stop: dateRange.dateStop,
      rows_upserted: 0,
      error_code: null,
      error_message: null,
      updated_at: createdAt,
      ...(requestKey ? { request_key: requestKey } : {}),
    })
    .select("id,workspace_id,meta_campaign_launch_id,status,date_start,date_stop,rows_upserted,error_code,error_message,started_at,finished_at,created_at")
    .single();
  if (pendingRunError) {
    if (requestKey && isUniqueViolationError(pendingRunError)) {
      // A concurrent cycle already created the run for this key: treat as an
      // already-processed no-op instead of a duplicate sync run.
      return {
        ...fail(new MetaInsightsError("persistence_failed", "Синхронизация уже выполняется."), null),
        status: "already_processed",
        error: null,
        dateStart: dateRange.dateStart,
        dateStop: dateRange.dateStop,
        accountTimezone: launchContext.accountTimezone,
        timezoneFallback,
      };
    }
    return fail(
      new MetaInsightsError("persistence_failed", "Не удалось создать журнал синхронизации Insights."),
      null,
    );
  }

  const pendingRun = asRecord(pendingRunValue);
  const runId = readString(pendingRun.id);
  if (!runId) {
    return fail(
      new MetaInsightsError("persistence_failed", "Журнал синхронизации Insights не вернул идентификатор."),
      null,
    );
  }

  const startedAt = new Date().toISOString();
  const { error: runningError } = await supabase
    .from("meta_insights_sync_runs")
    .update({ status: "running", started_at: startedAt, heartbeat_at: startedAt, updated_at: startedAt })
    .eq("id", runId)
    .eq("workspace_id", workspaceId);
  if (runningError) {
    const finishedAt = new Date().toISOString();
    await supabase
      .from("meta_insights_sync_runs")
      .update({
        status: "failed",
        error_code: "persistence_failed",
        error_message: "Не удалось запустить журнал синхронизации Insights.",
        heartbeat_at: finishedAt,
        finished_at: finishedAt,
        updated_at: finishedAt,
      })
      .eq("id", runId)
      .eq("workspace_id", workspaceId);
    return {
      ...fail(new MetaInsightsError("persistence_failed", "Не удалось запустить журнал синхронизации Insights."), runId),
      dateStart: dateRange.dateStart,
      dateStop: dateRange.dateStop,
      accountTimezone: launchContext.accountTimezone,
      timezoneFallback,
    };
  }

  try {
    const fetched = await fetchCampaignInsightsDaily({
      workspaceId,
      metaCampaignLaunchId: launchContext.launchId,
      metaCampaignId: launchContext.metaCampaignId,
      adAccountId: launchContext.adAccountId,
      expectedCurrency: launchContext.currency,
      accountTimezone: launchContext.accountTimezone,
      attributionSetting: launchContext.attributionSetting,
      dateStart: dateRange.dateStart,
      dateStop: dateRange.dateStop,
    });

    // Heartbeat after the Meta fetch and before persistence.
    const afterFetchAt = new Date().toISOString();
    await supabase
      .from("meta_insights_sync_runs")
      .update({ heartbeat_at: afterFetchAt, pages_fetched: fetched.pagesFetched, updated_at: afterFetchAt })
      .eq("id", runId)
      .eq("workspace_id", workspaceId);

    if (fetched.rows.length > 0) {
      const rows = fetched.rows.map(normalizedInsightToDatabaseRow);
      const { error: upsertError } = await supabase
        .from("meta_campaign_insights")
        .upsert(rows, {
          onConflict: "workspace_id,meta_campaign_launch_id,date_start,date_stop",
        });
      if (upsertError) {
        throw new MetaInsightsError("persistence_failed", "Не удалось сохранить нормализованные строки Insights.");
      }
    }

    // coverage_complete is set true only after full pagination and persistence.
    const finishedAt = new Date().toISOString();
    const { data: succeededRunValue, error: succeededRunError } = await supabase
      .from("meta_insights_sync_runs")
      .update({
        status: "succeeded",
        rows_upserted: fetched.rows.length,
        pages_fetched: fetched.pagesFetched,
        coverage_complete: true,
        error_code: null,
        error_message: null,
        heartbeat_at: finishedAt,
        finished_at: finishedAt,
        updated_at: finishedAt,
      })
      .eq("id", runId)
      .eq("workspace_id", workspaceId)
      .select("id,workspace_id,meta_campaign_launch_id,status,date_start,date_stop,rows_upserted,error_code,error_message,started_at,finished_at,created_at")
      .single();
    if (succeededRunError) {
      throw new MetaInsightsError("persistence_failed", "Не удалось завершить журнал синхронизации Insights.");
    }

    return {
      runId,
      status: "succeeded",
      rowsUpserted: fetched.rows.length,
      pagesFetched: fetched.pagesFetched,
      coverageComplete: true,
      empty: fetched.rows.length === 0,
      dateStart: dateRange.dateStart,
      dateStop: dateRange.dateStop,
      accountTimezone: launchContext.accountTimezone,
      timezoneFallback,
      finishedAt,
      error: null,
      run: mapMetaInsightsSyncRun(succeededRunValue),
    };
  } catch (error) {
    let safeError = asSafeMetaInsightsError(error);
    const finishedAt = new Date().toISOString();
    const { error: failedRunError } = await supabase
      .from("meta_insights_sync_runs")
      .update({
        status: "failed",
        rows_upserted: 0,
        error_code: safeError.code,
        error_message: safeError.message,
        heartbeat_at: finishedAt,
        finished_at: finishedAt,
        updated_at: finishedAt,
      })
      .eq("id", runId)
      .eq("workspace_id", workspaceId);
    if (failedRunError) {
      safeError = new MetaInsightsError("persistence_failed", "Не удалось сохранить безопасный результат синхронизации.");
    }
    return {
      runId,
      status: "failed",
      rowsUpserted: 0,
      pagesFetched: 0,
      coverageComplete: false,
      empty: false,
      dateStart: dateRange.dateStart,
      dateStop: dateRange.dateStop,
      accountTimezone: launchContext.accountTimezone,
      timezoneFallback,
      finishedAt,
      error: safeError,
      run: null,
    };
  }
}

type ClaimedInsightsState = {
  id: string;
  workspaceId: string;
  metaCampaignLaunchId: string;
  consecutiveFailureCount: number;
};

function backoffSecondsForFailureCount(failureCount: number): number {
  if (failureCount <= 1) return 15 * 60;
  if (failureCount === 2) return 60 * 60;
  return 6 * 60 * 60;
}

// Scheduler-state lifecycle for the background canary. Always clears our lease so
// a handled completion or failure never leaves an active lease behind.
async function finalizeBackgroundSchedulerState(
  supabase: CrmSupabaseClient,
  workerId: string,
  state: ClaimedInsightsState,
  outcome: MetaInsightsSyncOutcome,
): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const clearLease = { lease_owner: null, lease_expires_at: null };
  const pausedCadenceIso = new Date(
    now.getTime() + META_INSIGHTS_BACKGROUND_PAUSED_NEXT_SYNC_HOURS * 3_600_000,
  ).toISOString();

  const scopeUpdate = (values: JsonRecord) =>
    supabase
      .from("meta_insights_sync_state")
      .update({ ...values, updated_at: nowIso })
      .eq("id", state.id)
      .eq("workspace_id", state.workspaceId)
      .eq("lease_owner", workerId);

  if (outcome.status === "succeeded") {
    const completeness = evaluateMetaInsightsCompleteness({
      launchEligible: true,
      configurationAvailable: true,
      now: nowIso,
      accountTimeZone: outcome.accountTimezone || META_INSIGHTS_DEFAULT_TIMEZONE,
      requiredRange: {
        dateStart: outcome.dateStart ?? nowIso.slice(0, 10),
        dateStop: outcome.dateStop ?? nowIso.slice(0, 10),
      },
      freshnessDeadline: new Date(
        now.getTime() - META_INSIGHTS_BACKGROUND_FRESHNESS_SLA_HOURS * 3_600_000,
      ).toISOString(),
      latestRun: { status: "succeeded", coverageComplete: true },
      lease: null,
      successfulRuns: [
        {
          dateStart: outcome.dateStart ?? nowIso.slice(0, 10),
          dateStop: outcome.dateStop ?? nowIso.slice(0, 10),
          coverageComplete: true,
          completedAt: outcome.finishedAt ?? nowIso,
        },
      ],
      insightRowCountInRequiredRange: outcome.rowsUpserted,
    });
    // An uncertain account timezone leaves day boundaries untrusted, so the
    // canary records partial rather than a confident current/zero_delivery.
    const completenessStatus = outcome.timezoneFallback ? "partial" : completeness.status;

    await scopeUpdate({
      ...clearLease,
      last_success_at: outcome.finishedAt ?? nowIso,
      last_complete_date: completeness.lastCompleteDate,
      consecutive_failure_count: 0,
      last_error_code: null,
      paused_until: null,
      pause_reason: null,
      completeness_status: completenessStatus,
      next_sync_at: pausedCadenceIso,
    });
    return;
  }

  if (outcome.status === "already_processed") {
    await scopeUpdate({ ...clearLease, next_sync_at: pausedCadenceIso });
    return;
  }

  const failureCount = state.consecutiveFailureCount + 1;
  const errorCode = outcome.error?.code ?? "sync_timeout";
  const repeatedAuthFailure =
    (errorCode === "meta_auth" || errorCode === "meta_permission") && failureCount >= 2;
  const backoffSeconds = repeatedAuthFailure
    ? 6 * 60 * 60
    : backoffSecondsForFailureCount(failureCount);
  const nextSyncAt = new Date(now.getTime() + backoffSeconds * 1000).toISOString();
  const pausedUntil = repeatedAuthFailure
    ? new Date(now.getTime() + 6 * 3_600_000).toISOString()
    : null;

  await scopeUpdate({
    ...clearLease,
    consecutive_failure_count: failureCount,
    last_error_code: errorCode,
    completeness_status: "failed",
    next_sync_at: nextSyncAt,
    ...(pausedUntil ? { paused_until: pausedUntil, pause_reason: `${errorCode}_repeated` } : {}),
  });
}

function readWorkerRawBody(req: VercelRequest): Buffer {
  // Prefer exact raw bytes; fall back to the parsed body when the Vercel runtime
  // delivered req.body without req.rawBody. See resolveSignedRawBody for why the
  // parsed-body fallback is safe for this fixed JSON contract.
  const source = req as { rawBody?: unknown; body?: unknown };
  return resolveSignedRawBody({ rawBody: source.rawBody, body: source.body });
}

// The request id header is client-provided on a failed (unauthenticated) request,
// so sanitize it before logging: strip anything outside a safe id charset and cap
// the length to prevent log forging.
function readSafeWorkerRequestId(req: VercelRequest): string {
  const value = req.headers[WORKER_REQUEST_ID_HEADER];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 64) : "";
}

function sendWorkerAuthError(res: VercelResponse, error: unknown, req?: VercelRequest) {
  const statusCode = error instanceof WorkerAuthError ? error.statusCode : 503;
  // Safe server-side diagnostics only: endpoint, reason code, and a sanitized
  // request id. Never the secret, signature, canonical payload, body, body hash,
  // nonce, tokens, or the Authorization header. The reason is NOT sent to clients.
  const reason = error instanceof WorkerAuthError ? error.reason : "unknown";
  const requestId = req ? readSafeWorkerRequestId(req) : "";
  console.warn(
    `[meta-insights-cycle] worker auth rejected reason=${reason}${requestId ? ` requestId=${requestId}` : ""}`,
  );
  // Never echo the worker secret, signature, or the specific failure detail.
  return sendJson(res, statusCode, {
    ...errorBody("Worker authentication failed"),
    code: "worker_unauthorized",
  });
}

// POST /api/crm/meta-insights-background-cycle — HMAC-authenticated background
// Meta Insights sync. It never requires a user Bearer token, never trusts a
// workspaceId as proof, and returns only a safe summary.
export async function handleMetaInsightsBackgroundCycle(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use POST"]));
  }

  let authConfig: WorkerAuthConfig;
  let verified: VerifiedWorkerRequest;
  try {
    authConfig = getWorkerAuthConfig();
    verified = verifyWorkerRequest({
      method: "POST",
      path: META_INSIGHTS_BACKGROUND_CYCLE_PATH,
      headers: req.headers,
      rawBody: readWorkerRawBody(req),
      config: authConfig,
    });
  } catch (error) {
    return sendWorkerAuthError(res, error, req);
  }

  const body = asRecord(req.body);
  const workerId = firstString(body.workerId, body.worker_id);
  if (!workerId || workerId.length > 200) {
    return sendJson(res, 400, errorBody("Validation error", ["workerId is required"]));
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, {
      ...errorBody("Meta Insights background cycle unavailable", ["Supabase недоступен."]),
      code: "persistence_failed",
      data: { requestId: verified.requestId },
    });
  }

  const allowlist = authConfig.workspaceAllowlist;
  const requestedWorkspaceIds = readJsonArray(body.workspaceIds ?? body.workspace_ids)
    .map((value) => readString(value).toLowerCase())
    .filter((value) => isUuid(value));
  const effectiveWorkspaceIds = requestedWorkspaceIds.length > 0
    ? requestedWorkspaceIds.filter((id) => allowlist.includes(id))
    : allowlist;

  const summary = {
    success: true as const,
    requestId: verified.requestId,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    results: [] as JsonRecord[],
  };

  if (effectiveWorkspaceIds.length === 0) {
    console.log(`[meta-insights-cycle] request ${verified.requestId} worker ${workerId} no allowed workspaces`);
    return sendJson(res, 200, summary);
  }

  const maxLaunchesRaw = readNumber(body.maxLaunches ?? body.max_launches);
  const maxLaunches = Math.min(
    Math.max(
      maxLaunchesRaw && maxLaunchesRaw > 0
        ? Math.trunc(maxLaunchesRaw)
        : META_INSIGHTS_BACKGROUND_MAX_LAUNCHES_DEFAULT,
      1,
    ),
    META_INSIGHTS_BACKGROUND_MAX_LAUNCHES_ABSOLUTE,
  );

  let claimedRows: JsonRecord[];
  try {
    const { data, error } = await supabase.rpc("claim_due_meta_insights_sync_states", {
      p_worker_id: workerId,
      p_limit: maxLaunches,
      p_lease_seconds: META_INSIGHTS_BACKGROUND_LEASE_SECONDS,
      p_workspace_ids: effectiveWorkspaceIds,
    });
    if (error) throw error;
    claimedRows = Array.isArray(data) ? data.map((row) => asRecord(row)) : [];
  } catch {
    return sendJson(res, 503, {
      ...errorBody("Meta Insights background cycle unavailable", ["Не удалось получить задачи синхронизации."]),
      code: "persistence_failed",
      data: { requestId: verified.requestId },
    });
  }

  summary.claimed = claimedRows.length;

  // Canary concurrency is 1: claimed launches are processed sequentially.
  for (const row of claimedRows) {
    const state: ClaimedInsightsState = {
      id: readString(row.id),
      workspaceId: readString(row.workspace_id),
      metaCampaignLaunchId: readString(row.meta_campaign_launch_id),
      consecutiveFailureCount: readNumber(row.consecutive_failure_count) ?? 0,
    };
    if (!isUuid(state.id) || !isUuid(state.workspaceId) || !isUuid(state.metaCampaignLaunchId)) {
      summary.skipped += 1;
      continue;
    }

    const outcome = await syncMetaInsightsForLaunch({
      supabase,
      workspaceId: state.workspaceId,
      metaCampaignLaunchId: state.metaCampaignLaunchId,
      trigger: "background",
      authMode: "worker_hmac",
      requestKey: `bg:${verified.requestId}:${state.metaCampaignLaunchId}`,
    });

    try {
      await finalizeBackgroundSchedulerState(supabase, workerId, state, outcome);
    } catch {
      // Scheduler bookkeeping failure must not leak details; the run row already
      // carries the safe result and the lease expires on its own.
    }

    if (outcome.status === "succeeded") summary.succeeded += 1;
    else if (outcome.status === "failed") summary.failed += 1;
    else summary.skipped += 1;

    summary.results.push({
      metaCampaignLaunchId: state.metaCampaignLaunchId,
      runId: outcome.runId,
      status: outcome.status,
      rowsUpserted: outcome.rowsUpserted,
      safeErrorCode: outcome.error?.code ?? null,
    });

    console.log(
      `[meta-insights-cycle] request ${verified.requestId} worker ${workerId} workspace ${state.workspaceId} ` +
        `launch ${state.metaCampaignLaunchId} run ${outcome.runId ?? "none"} status ${outcome.status} ` +
        `rows ${outcome.rowsUpserted} code ${outcome.error?.code ?? "none"}`,
    );
  }

  return sendJson(res, 200, summary);
}

export async function handleMetaInsightsSync(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use POST"]));
  }

  const body = asRecord(req.body);
  const workspaceId = readWorkspaceId(req, body);
  if (!isUuid(workspaceId)) {
    return sendJson(res, 400, errorBody("Validation error", ["workspaceId must be a UUID"]));
  }

  try {
    await requireWorkspaceAdmin(req, workspaceId);
  } catch (error) {
    return sendWorkspaceAdminAuthError(res, error);
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendMetaInsightsFailure(
      res,
      new MetaInsightsError("persistence_failed", "Supabase недоступен для синхронизации Insights."),
    );
  }

  const outcome = await syncMetaInsightsForLaunch({
    supabase,
    workspaceId,
    metaCampaignLaunchId: firstString(body.metaCampaignLaunchId, body.meta_campaign_launch_id),
    dateStart: firstString(body.dateStart, body.date_start) || undefined,
    dateStop: firstString(body.dateStop, body.date_stop) || undefined,
    trigger: "manual",
    authMode: "user_admin",
  });

  if (outcome.status !== "succeeded" || !outcome.run) {
    return sendMetaInsightsFailure(
      res,
      outcome.error ?? new MetaInsightsError("sync_timeout", "Синхронизация Meta Insights не завершилась."),
      outcome.runId ?? undefined,
    );
  }

  return sendJson(
    res,
    200,
    success("supabase", {
      run: outcome.run,
      rowsUpserted: outcome.rowsUpserted,
      empty: outcome.empty,
      pagesFetched: outcome.pagesFetched,
      dateStart: outcome.dateStart,
      dateStop: outcome.dateStop,
    }),
  );
}

export async function handleMetaCampaignInsights(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use GET"]));
  }

  const workspaceId = readWorkspaceId(req, {});
  if (!isUuid(workspaceId)) {
    return sendJson(res, 400, errorBody("Validation error", ["workspaceId must be a UUID"]));
  }

  try {
    await requireWorkspaceAdmin(req, workspaceId);
  } catch (error) {
    return sendWorkspaceAdminAuthError(res, error);
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendMetaInsightsFailure(
      res,
      new MetaInsightsError("persistence_failed", "Supabase недоступен для чтения Insights."),
    );
  }

  const launchId = readQueryString(req.query.metaCampaignLaunchId ?? req.query.meta_campaign_launch_id);
  if (launchId && !isUuid(launchId)) {
    return sendMetaInsightsFailure(res, new MetaInsightsError("launch_not_eligible", "metaCampaignLaunchId должен быть UUID."));
  }
  const dateStart = readQueryString(req.query.dateStart ?? req.query.date_start);
  const dateStop = readQueryString(req.query.dateStop ?? req.query.date_stop);
  if ((dateStart && !isIsoCalendarDate(dateStart)) || (dateStop && !isIsoCalendarDate(dateStop)) || (dateStart && dateStop && dateStart > dateStop)) {
    return sendMetaInsightsFailure(res, new MetaInsightsError("invalid_range", "Период Insights указан неверно."));
  }

  let query = supabase
    .from("meta_campaign_insights")
    .select("id,workspace_id,meta_campaign_launch_id,meta_campaign_id,date_start,date_stop,spend_minor,currency,impressions,reach,clicks,inline_link_clicks,meta_leads,action_counts,fetched_at,updated_at")
    .eq("workspace_id", workspaceId)
    .order("date_start", { ascending: false })
    .limit(500);
  if (launchId) query = query.eq("meta_campaign_launch_id", launchId);
  if (dateStart) query = query.gte("date_start", dateStart);
  if (dateStop) query = query.lte("date_stop", dateStop);

  const { data, error } = await query;
  if (error) {
    return sendMetaInsightsFailure(
      res,
      new MetaInsightsError("persistence_failed", "Не удалось прочитать нормализованные Meta Insights."),
    );
  }

  const insights = (Array.isArray(data) ? data : []).map(mapMetaCampaignInsight);
  return sendJson(res, 200, success("supabase", { insights, items: insights }));
}

export async function handleMetaInsightsHistory(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use GET"]));
  }

  const workspaceId = readWorkspaceId(req, {});
  if (!isUuid(workspaceId)) {
    return sendJson(res, 400, errorBody("Validation error", ["workspaceId must be a UUID"]));
  }

  try {
    await requireWorkspaceAdmin(req, workspaceId);
  } catch (error) {
    return sendWorkspaceAdminAuthError(res, error);
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendMetaInsightsFailure(
      res,
      new MetaInsightsError("persistence_failed", "Supabase недоступен для чтения сводки Insights."),
    );
  }

  try {
    const { data: launchData, error: launchError } = await supabase
      .from("meta_campaign_launches")
      .select("id,status,meta_status,meta_campaign_id,payload,meta_response,created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(META_INSIGHTS_HISTORY_LAUNCH_LIMIT);
    if (launchError) {
      throw new MetaInsightsError("persistence_failed", "Не удалось прочитать историю Meta launch.");
    }

    const launches = (Array.isArray(launchData) ? launchData : []).map(asRecord);
    const launchIds = launches.map((launch) => readString(launch.id)).filter(isUuid);
    const eligibleLaunches = launches.filter(isMetaInsightsHistoryLaunchEligible);
    const eligibleLaunchIds = eligibleLaunches.map((launch) => readString(launch.id));
    const expectedCampaignByLaunch = new Map(
      eligibleLaunches.map((launch) => [readString(launch.id), readString(launch.meta_campaign_id)]),
    );

    const [latestRunsByLaunch, insightRows] = await Promise.all([
      loadLatestMetaInsightsRunsByLaunch(supabase, workspaceId, launchIds),
      loadMetaInsightsHistoryRows(supabase, workspaceId, eligibleLaunchIds),
    ]);

    const aggregates = new Map<string, MetaInsightsHistoryAggregate>();
    for (const row of insightRows) {
      const launchId = readString(row.meta_campaign_launch_id);
      const expectedMetaCampaignId = expectedCampaignByLaunch.get(launchId);
      if (!expectedMetaCampaignId) {
        throw new MetaInsightsError("persistence_failed", "Сохранённые Insights ссылаются на неподходящий Meta launch.");
      }
      const aggregate = aggregates.get(launchId) || emptyMetaInsightsHistoryAggregate();
      aggregateMetaInsightsHistoryRow(aggregate, row, expectedMetaCampaignId);
      aggregates.set(launchId, aggregate);
    }

    const summaries = launches.map((launch) => {
      const launchId = readString(launch.id);
      const eligible = isMetaInsightsHistoryLaunchEligible(launch);
      const aggregate = aggregates.get(launchId);
      const latestRun = latestRunsByLaunch.get(launchId);
      return {
        metaCampaignLaunchId: launchId,
        availability: resolveMetaInsightsHistoryAvailability({ eligible, aggregate, latestRun }),
        lastRun: mapMetaInsightsHistoryLastRun(latestRun),
        coveredDateStart: aggregate?.coveredDateStart || null,
        coveredDateStop: aggregate?.coveredDateStop || null,
        latestFetchedAt: aggregate?.latestFetchedAt || null,
        rowCount: aggregate?.rowCount || 0,
        spendByCurrency: aggregate
          ? [...aggregate.spendByCurrency.values()]
              .sort((left, right) => `${left.currency}:${left.currencyExponent}`.localeCompare(`${right.currency}:${right.currencyExponent}`))
              .map((item) => ({
                currency: item.currency,
                currencyExponent: item.currencyExponent,
                spendMinor: item.spendMinor.toString(),
              }))
          : [],
        impressions: (aggregate?.impressions || 0n).toString(),
        clicks: (aggregate?.clicks || 0n).toString(),
        inlineLinkClicks: (aggregate?.inlineLinkClicks || 0n).toString(),
        metaLeads: aggregate?.hasMetaLeads ? aggregate.metaLeads.toString() : null,
      };
    });

    return sendJson(res, 200, success("supabase", { summaries, items: summaries }));
  } catch (error) {
    const safeError =
      error instanceof MetaInsightsError
        ? error
        : new MetaInsightsError("persistence_failed", "Не удалось построить безопасную сводку Meta Insights.");
    return sendMetaInsightsFailure(res, safeError);
  }
}

export async function handleMetaInsightsSyncRuns(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use GET"]));
  }

  const workspaceId = readWorkspaceId(req, {});
  if (!isUuid(workspaceId)) {
    return sendJson(res, 400, errorBody("Validation error", ["workspaceId must be a UUID"]));
  }

  try {
    await requireWorkspaceAdmin(req, workspaceId);
  } catch (error) {
    return sendWorkspaceAdminAuthError(res, error);
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendMetaInsightsFailure(
      res,
      new MetaInsightsError("persistence_failed", "Supabase недоступен для чтения журнала Insights."),
    );
  }

  const launchId = readQueryString(req.query.metaCampaignLaunchId ?? req.query.meta_campaign_launch_id);
  if (launchId && !isUuid(launchId)) {
    return sendMetaInsightsFailure(res, new MetaInsightsError("launch_not_eligible", "metaCampaignLaunchId должен быть UUID."));
  }

  let query = supabase
    .from("meta_insights_sync_runs")
    .select("id,workspace_id,meta_campaign_launch_id,status,date_start,date_stop,rows_upserted,error_code,error_message,started_at,finished_at,created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (launchId) query = query.eq("meta_campaign_launch_id", launchId);

  const { data, error } = await query;
  if (error) {
    return sendMetaInsightsFailure(
      res,
      new MetaInsightsError("persistence_failed", "Не удалось прочитать журнал синхронизаций Insights."),
    );
  }

  const runs = (Array.isArray(data) ? data : []).map(mapMetaInsightsSyncRun);
  return sendJson(res, 200, success("supabase", { runs, items: runs }));
}

/**
 * Names for workspaces the caller is already a verified member of.
 *
 * Selection-1: the ids come from listAuthContextMemberships and never from the
 * request, so this discloses nothing the caller was not already told. It is a
 * separate query rather than a join in listActiveMemberships because that runs
 * on every authorized request and this is needed once, at the bootstrap.
 *
 * A failure here is not an authentication failure: the picker falls back to the
 * role and the id, which is worse to read but still correct.
 */
async function lookupWorkspaceNames(workspaceIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(workspaceIds.filter((id) => isUuid(id)))];
  if (ids.length === 0) return {};

  const supabase = getSupabaseServerClient();
  if (!supabase) return {};

  try {
    const { data, error } = await supabase.from("workspaces").select("id, name").in("id", ids);
    if (error) throw new Error(error.message);

    const names: Record<string, string> = {};
    for (const row of Array.isArray(data) ? data : []) {
      const record = asRecord(row);
      const id = firstString(record.id);
      const name = firstString(record.name);
      if (id && name) names[id] = name;
    }
    return names;
  } catch (error) {
    console.warn(supabaseWarning("workspace names", error));
    return {};
  }
}

export async function handleCrmAuthContext(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use GET"]));
  }

  // Security-2B: identity bootstrap. The router already verified the JWT; this
  // returns only the caller's own active memberships with server-computed
  // permissions. No email lookup, no browser role, no impersonation input.
  try {
    const { memberships } = await listAuthContextMemberships(req);
    // Selection-1: a caller with several memberships has to pick one, and a
    // list of UUIDs is not a choice anyone can make.
    const workspaceNames = await lookupWorkspaceNames(memberships.map((membership) => membership.workspaceId));
    const safeMemberships = memberships.map((membership) => ({
      staffUserId: membership.staffUserId,
      workspaceId: membership.workspaceId,
      workspaceName: workspaceNames[membership.workspaceId] || "",
      role: membership.role,
      permissions: membership.permissions,
      status: "active",
    }));

    return sendJson(
      res,
      200,
      success("supabase", {
        memberships: safeMemberships,
        // With exactly one membership the server may select it; with several the
        // client must choose, so no workspace is implied here.
        workspaceId: safeMemberships.length === 1 ? safeMemberships[0].workspaceId : null,
        role: safeMemberships.length === 1 ? safeMemberships[0].role : null,
        staffUserId: safeMemberships.length === 1 ? safeMemberships[0].staffUserId : null,
        permissions: safeMemberships.length === 1 ? safeMemberships[0].permissions : [],
        requiresWorkspaceSelection: safeMemberships.length > 1,
      }),
    );
  } catch (error) {
    if (error instanceof WorkspaceAdminAuthError) {
      return sendJson(res, error.statusCode, { success: false, error: error.message, code: error.code });
    }
    return sendJson(res, 503, errorBody("Authentication service unavailable"));
  }
}

export async function handleCrmResource(resource: CrmResource, req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    return listItems(resource, req, res);
  }

  if (req.method === "POST") {
    return createItem(resource, req, res);
  }

  if (req.method === "PATCH") {
    return patchItem(resource, req, res);
  }

  return sendJson(res, 405, errorBody("Method not allowed", ["Use GET, POST or PATCH"]));
}

export async function persistContentVideoPatchIfAvailable(input: {
  videoId?: unknown;
  workspaceId?: unknown;
  patch: JsonRecord;
}) {
  const id = readString(input.videoId);
  const workspaceId = readString(input.workspaceId);
  const supabase = getSupabaseServerClient();

  // Security-2D: the workspace is required, not optional. This ran on the
  // service-role client, so an update filtered by id alone would patch whichever
  // workspace owned that row — and until this phase the id and the workspace
  // both came straight from an unauthenticated request body.
  if (!supabase || !isUuid(id) || !isUuid(workspaceId)) {
    return;
  }

  const row = buildPatchRow("content-videos", input.patch);
  if (Object.keys(row).length === 0) {
    return;
  }

  try {
    const { error } = await supabase
      .from("content_videos")
      .update(row)
      .eq("id", id)
      .eq("workspace_id", workspaceId);
    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    console.warn(supabaseWarning("content_videos", error));
  }
}
