import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";

export type CrmResource =
  | "clients"
  | "leads"
  | "appointments"
  | "calls"
  | "tasks"
  | "chat"
  | "staff"
  | "content-videos";

type CrmMode = "supabase" | "demo";
type JsonRecord = Record<string, unknown>;
type QueryValue = string | string[] | undefined;

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
    setText("service", ["service"]);
    setText("doctor_name", ["doctor", "doctor_name", "doctorName"]);
    setDate("starts_at", ["starts_at", "startsAt"]);
    setText("status", ["status"]);
    setText("notes", ["notes", "time"]);
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

  return details;
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
  return {
    id: readString(body.id) || nextDemoId("appointment"),
    time: firstString(body.time, body.starts_at),
    client: firstString(body.client, body.client_name, body.clientName),
    phone: firstString(body.phone, body.client_phone, body.clientPhone),
    service: readString(body.service),
    doctor: firstString(body.doctor, body.doctor_name, body.doctorName),
    status: readString(body.status) || "scheduled",
    notes: readString(body.notes),
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
      service: readString(body.service) || null,
      doctor_name: firstString(body.doctor, body.doctor_name, body.doctorName) || null,
      starts_at: maybeDate(body.starts_at ?? body.startsAt),
      status: readString(body.status) || "scheduled",
      notes: firstString(body.notes, body.time) || null,
      updated_at: new Date().toISOString(),
    }),
    fromRow: (row) =>
      makeAppointment({
        id: row.id,
        client: row.client_name,
        phone: row.client_phone,
        service: row.service,
        doctor: row.doctor_name,
        time: row.starts_at || row.notes,
        status: row.status,
        notes: row.notes,
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
    const { data, error } = await supabase.from(config.table).insert(row).select("*").single();

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
