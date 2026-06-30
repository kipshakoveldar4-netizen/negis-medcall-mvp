import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { checkMetaCompliance } from "../meta/compliance";
import { checkMetaAdAccount, getMetaCampaignStatus, getMetaConfig, launchMetaCampaign, uploadMetaVideo } from "../meta/marketing";

export type CrmResource =
  | "clients"
  | "leads"
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
  upsertConflict?: string;
  toRow: (body: JsonRecord, workspaceId: string) => JsonRecord;
  fromRow: (row: JsonRecord) => JsonRecord;
  demoItem: (body: JsonRecord) => JsonRecord;
};

const DEMO_WORKSPACE_ID = "demo-workspace";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
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
    body.url,
    body.imageUrl,
    body.image_url,
    body.videoUrl,
    body.video_url,
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
    setText("notes", ["notes", "owner"]);
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
    setText("priority", ["priority"]);
    setText("status", ["status"]);
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
    setText("public_url", ["publicUrl", "public_url", "url", "creativeUrl", "creative_url"]);
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

  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
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

function readWorkspaceId(req: VercelRequest, body: JsonRecord): string {
  const queryValue = req.query.workspaceId ?? req.query.workspace_id;
  const queryWorkspaceId = Array.isArray(queryValue) ? queryValue[0] : queryValue;
  return firstString(body.workspaceId, body.workspace_id, queryWorkspaceId, DEMO_WORKSPACE_ID);
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

  if (resource === "leads" && !firstString(body.name, body.full_name, body.fullName, body.phone)) {
    details.push("name or phone is required");
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

  return {
    status,
    configured: configured.length,
    total: keys.length,
    keys: keys.map((key) => ({
      key,
      configured: Boolean(process.env[key]?.trim()),
    })),
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
  };
}

function makeTask(body: JsonRecord): JsonRecord {
  return {
    id: readString(body.id) || nextDemoId("task"),
    title: readString(body.title),
    description: readString(body.description),
    owner: firstString(body.owner, body.assignee_name, body.assigneeName),
    deadline: firstString(body.deadline, body.due_at),
    priority: readString(body.priority) || "medium",
    status: readString(body.status) || "new",
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
      }),
  },
  leads: {
    table: "leads",
    listKey: "leads",
    requiredPost: [],
    sortableColumn: "created_at",
    demoItem: makeLead,
    toRow: (body, workspaceId) => ({
      workspace_id: workspaceId,
      full_name: firstString(body.name, body.full_name, body.fullName) || null,
      phone: readString(body.phone) || null,
      source: readString(body.source) || null,
      campaign: readString(body.campaign) || null,
      status: readString(body.status) || "new",
      notes: firstString(body.notes, body.owner) || null,
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeLead({
        id: row.id,
        name: row.full_name,
        phone: row.phone,
        source: row.source,
        campaign: row.campaign,
        status: row.status,
        owner: row.notes,
        notes: row.notes,
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
      duration_minutes: readNumber(body.durationMinutes ?? body.duration_minutes) ?? 60,
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
      priority: readString(body.priority) || "medium",
      status: readString(body.status) || "new",
      due_at: maybeDate(body.due_at ?? body.dueAt),
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

async function listItems(resource: CrmResource, req: VercelRequest, res: VercelResponse) {
  const config = configs[resource];
  const workspaceId = readWorkspaceId(req, {});
  const emailFilter = resource === "staff" ? readQueryString(req.query.email).toLowerCase() : "";
  const supabase = getSupabaseServerClient();

  if (!supabase || (!emailFilter && !isUuid(workspaceId))) {
    return sendJson(
      res,
      200,
      success("demo", { [config.listKey]: [], items: [] }, !supabase ? "Supabase env is not configured" : "Demo workspace uses localStorage"),
    );
  }

  try {
    let query = supabase
      .from(config.table)
      .select("*")
      .order(config.sortableColumn, { ascending: false });

    if (emailFilter) {
      query = query.eq("email", emailFilter).limit(1);
    } else {
      query = query.eq("workspace_id", workspaceId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    const items = (Array.isArray(data) ? data : []).map((row) => config.fromRow(asRecord(row)));
    return sendJson(res, 200, success("supabase", { [config.listKey]: items, items }));
  } catch (error) {
    const warning = supabaseWarning(config.table, error);
    console.warn(warning);
    return sendJson(res, 200, success("demo", { [config.listKey]: [], items: [] }, warning));
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
    const query = config.upsertConflict
      ? supabase.from(config.table).upsert(row, { onConflict: config.upsertConflict }).select("*").single()
      : supabase.from(config.table).insert(row).select("*").single();
    const { data, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    const item = config.fromRow(asRecord(data));
    return sendJson(res, 201, success("supabase", { [resource === "content-videos" ? "video" : "item"]: item, item }));
  } catch (error) {
    const warning = supabaseWarning(config.table, error);
    console.warn(warning);
    return sendJson(res, 200, success("demo", { [resource === "content-videos" ? "video" : "item"]: demoItem, item: demoItem }, warning));
  }
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
    const row = buildPatchRow(resource, patchBody);

    if (Object.keys(row).length === 0) {
      return sendJson(res, 200, success("supabase", { [resource === "content-videos" ? "video" : "item"]: demoItem, item: demoItem }));
    }

    const { data, error } = await supabase
      .from(config.table)
      .update(row)
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .select("*")
      .single();

    if (error) {
      throw new Error(error.message);
    }

    const item = config.fromRow(asRecord(data));
    return sendJson(res, 200, success("supabase", { [resource === "content-videos" ? "video" : "item"]: item, item }));
  } catch (error) {
    const warning = supabaseWarning(config.table, error);
    console.warn(warning);
    return sendJson(res, 200, success("demo", { [resource === "content-videos" ? "video" : "item"]: demoItem, item: demoItem }, warning));
  }
}

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

function fileExtension(fileName: string): string {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
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

export async function handleAdCreativeUpload(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use POST"]));
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
    const metaResponse = await uploadMetaVideo({ videoUrl: publicUrl, title });
    const metaVideoId = firstString(metaResponse.id, metaResponse.video_id);
    if (!metaVideoId) {
      throw new Error("Meta вернула ответ без video_id");
    }

    await updateAdCreativeMeta({
      workspaceId,
      assetId,
      metaVideoId,
      status: "meta_uploaded",
      metadata: { metaResponse },
    });

    return sendJson(
      res,
      200,
      success("supabase", {
        assetId,
        metaVideoId,
        status: "meta_uploaded",
        metaResponse,
      }),
    );
  } catch (error) {
    return sendJson(
      res,
      502,
      errorBody("Видео загружено в Negis, но Meta не приняла видео", [
        error instanceof Error
          ? `${error.message}. Проверьте формат MP4, размер и права токена.`
          : "Проверьте формат MP4, размер и права токена.",
      ]),
    );
  }
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
      note: `Город: ${city}. Уточнение интересов вручную в Ads Manager при необходимости.`,
    },
    placements: ["Facebook Feed", "Instagram Feed", "Stories/Reels"],
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
  const campaignName = firstString(body.campaignName, body.campaign_name);
  const primaryText = firstString(body.primaryText, body.primary_text, body.creativeText, body.caption);
  const headline = firstString(body.headline, campaignName);
  const description = firstString(body.description, body.offer, body.service, body.niche);
  const dailyBudget = readNumber(body.dailyBudget ?? body.daily_budget ?? body.budget) ?? 0;
  const days = dateDays(firstString(body.startDate, body.start_time), firstString(body.endDate, body.end_time));
  const totalBudget = readNumber(body.totalBudget ?? body.total_budget) ?? dailyBudget * days;
  const config = getMetaConfig();

  return {
    campaignName,
    objective: firstString(body.objective, "OUTCOME_LEADS"),
    statusMode: normalizeMetaStatus(body.statusMode ?? body.status),
    dailyBudget,
    totalBudget,
    dailyBudgetMinor: budgetToMinor(dailyBudget),
    totalBudgetMinor: budgetToMinor(totalBudget),
    currency: readString(body.currency) || "USD",
    city: firstString(body.city, "Astana"),
    targetAudience: firstString(body.targetAudience, body.target_audience, "Women 25-55"),
    primaryText,
    headline,
    description,
    cta: firstString(body.cta, "LEARN_MORE").toUpperCase().replace(/\s+/g, "_"),
    landingUrl: firstString(body.landingUrl, body.landing_url, body.websiteUrl, body.website_url),
    imageUrl: firstString(body.imageUrl, body.image_url),
    creativeUrl: firstString(body.creativeUrl, body.creative_url),
    creativeType: normalizeCreativeFileType(body),
    videoUrl: firstString(body.videoUrl, body.video_url, body.creativeUrl, body.creative_url),
    videoId: firstString(body.videoId, body.video_id, body.metaVideoId, body.meta_video_id),
    thumbnailUrl: firstString(body.thumbnailUrl, body.thumbnail_url),
    startDate: firstString(body.startDate, body.start_time, new Date(Date.now() + 3600000).toISOString()),
    endDate: firstString(body.endDate, body.end_time),
    pageId: config.pageId,
    instagramActorId: config.instagramActorId,
    adAccountId: config.adAccountId,
  };
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
        hasAccessToken: Boolean(config.accessToken),
      }, "Meta env не настроены."),
    );
  }

  try {
    const account = await checkMetaAdAccount();
    return sendJson(
      res,
      200,
      success("supabase", {
        configured: true,
        account,
        adAccountId: config.adAccountId,
        pageId: config.pageId,
        instagramActorId: config.instagramActorId,
        hasAccessToken: true,
      }),
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

export async function handleMetaLaunch(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use POST"]));
  }

  const body = asRecord(req.body);
  const workspaceId = readWorkspaceId(req, body);
  const launch = buildMetaLaunchBody(body);
  const actorName = firstString(body.launchedBy, body.actorName, body.userName);
  const actorRole = firstString(body.launchedByRole, body.actorRole, "owner");
  const details: string[] = [];

  if (!launch.campaignName) details.push("Название кампании обязательно.");
  if (!launch.primaryText) details.push("Текст объявления обязателен.");
  if (!launch.headline) details.push("Заголовок обязателен.");
  if (!launch.dailyBudget || launch.dailyBudgetMinor <= 0) details.push("Укажите дневной бюджет больше 0.");
  if (!launch.landingUrl) details.push("Укажите, куда должны приходить заявки.");
  if (!launch.imageUrl && !launch.creativeUrl && !launch.videoUrl) details.push("Креатив загружен, но публичная ссылка не получена.");
  if (launch.creativeType === "video" && !launch.videoId && !launch.videoUrl) {
    details.push("Для видео нужен Meta video_id или публичная ссылка для загрузки в Meta.");
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

  const payload: JsonRecord = {
    workspaceId,
    launchedBy: actorName,
    launchedByRole: actorRole,
    sourceModule: firstString(body.sourceModule, body.source_module, "ads-automation"),
    sourceId: firstString(body.sourceId, body.source_id),
    campaignName: launch.campaignName,
    objective: launch.objective,
    status: launch.statusMode === "ACTIVE" ? "active" : "paused",
    budgetDailyMinor: launch.dailyBudgetMinor,
    budgetTotalMinor: launch.totalBudgetMinor,
    currency: launch.currency,
    startTime: launch.startDate,
    endTime: launch.endDate,
    pageId: launch.pageId,
    instagramActorId: launch.instagramActorId,
    adAccountId: launch.adAccountId,
    payload: {
      ...sanitizeLaunchPayload(body),
    },
    compliance,
  };

  const dryRun = readBoolean(body.dryRun);
  const config = getMetaConfig();
  let metaResponse: JsonRecord;
  let launchStatus = launch.statusMode === "ACTIVE" ? "active" : "paused";
  let warning = "";

  try {
    if (dryRun) {
      metaResponse = {
        dryRun: true,
        metaCampaignId: demoMetaId("campaign"),
        metaAdSetId: demoMetaId("adset"),
        metaCreativeId: demoMetaId("creative"),
        metaAdId: demoMetaId("ad"),
      };
      warning = "Проверка прошла без запуска: Meta API не вызывался.";
    } else {
      if (!config.configured) {
        throw new Error("Meta env is not configured");
      }
      const result = await launchMetaCampaign({
        campaignName: launch.campaignName,
        objective: launch.objective,
        status: launch.statusMode,
        dailyBudgetMinor: launch.dailyBudgetMinor,
        lifetimeBudgetMinor: launch.totalBudgetMinor,
        currency: launch.currency,
        primaryText: launch.primaryText,
        headline: launch.headline,
        description: launch.description,
        cta: launch.cta,
        landingUrl: launch.landingUrl,
        imageUrl: launch.imageUrl || launch.creativeUrl,
        creativeType: launch.creativeType,
        videoUrl: launch.videoUrl || launch.creativeUrl,
        videoId: launch.videoId,
        thumbnailUrl: launch.thumbnailUrl,
        startTime: launch.startDate,
        endTime: launch.endDate || undefined,
      });
      metaResponse = result;
    }
  } catch (error) {
    const rawError = error instanceof Error ? error.message : "Не удалось создать рекламу в Meta";
    const lastError = localizeMetaLaunchError(rawError);
    const saved = await persistMetaLaunch({
      workspaceId,
      payload,
      compliance: compliance as unknown as JsonRecord,
      metaResponse: {},
      status: "failed",
      metaStatus: "failed",
      lastError,
    });
    return sendJson(res, 502, {
      ...errorBody("Не удалось создать рекламу в Meta", [lastError]),
      mode: saved.mode,
      data: { launch: saved.item, compliance, safeText: compliance.safeText },
    });
  }

  const ids = extractMetaIds(metaResponse);
  const saved = await persistMetaLaunch({
    workspaceId,
    payload: {
      ...payload,
      ...ids,
      metaStatus: launch.statusMode,
    },
    compliance: compliance as unknown as JsonRecord,
    metaResponse,
    status: launchStatus,
    metaStatus: launch.statusMode,
  });

  const launchId = firstString(asRecord(saved.item).id);
  await insertMetaAuditLog({
    workspaceId,
    launchId,
    actorName,
    actorRole,
    action: dryRun ? "dry_run" : launch.statusMode === "ACTIVE" ? "launch_active" : "create_paused",
    details: {
      campaignName: launch.campaignName,
      statusMode: launch.statusMode,
      dryRun,
      complianceStatus: compliance.status,
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
      ...ids,
      status: launchStatus,
      metaStatus: launch.statusMode,
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
    businessId: readEnvValue("META_BUSINESS_ID"),
    adAccountId: readEnvValue("META_AD_ACCOUNT_ID"),
    pageId: readEnvValue("META_PAGE_ID"),
    instagramActorId: readEnvValue("META_INSTAGRAM_ACTOR_ID"),
    hasAccessToken: Boolean(readEnvValue("META_ACCESS_TOKEN")),
    hasAppSecret: Boolean(readEnvValue("META_APP_SECRET")),
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

  if (!supabase || !isUuid(id)) {
    return;
  }

  const row = buildPatchRow("content-videos", input.patch);
  if (Object.keys(row).length === 0) {
    return;
  }

  try {
    const query = supabase.from("content_videos").update(row).eq("id", id);
    if (isUuid(workspaceId)) {
      query.eq("workspace_id", workspaceId);
    }

    const { error } = await query;
    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    console.warn(supabaseWarning("content_videos", error));
  }
}
