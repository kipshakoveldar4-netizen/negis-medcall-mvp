import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";

// The clinic-facing view of its WhatsApp connection.
//
// Two providers feed one inbound pipeline (lib/crm/inbound-whatsapp.ts): the
// Wazzup bridge of phase 1 and the official WhatsApp Cloud API of phase 2.
// Each keeps its own tenancy table — wazzup_channels (026) and
// whatsapp_cloud_numbers (027) — because their channel keys are different
// things: a Wazzup channelId is a uuid the intermediary issues, a Cloud key is
// Meta's phone_number_id. This route unions them into one list so the clinic
// sees "our WhatsApp", not our implementation history.
//
// What it deliberately does NOT expose: nothing here is patient data. The rows
// hold the clinic's own channel identifiers and counters; message contents,
// sender phones and names live in leads and in the ledgers and are never read
// by this route. The activity numbers come from counting ledger rows, not from
// reading them.
//
// Tenancy: the workspace comes from the verified context the router attached,
// never from the request. Every query and every update is filtered by it, and
// an id that belongs to another clinic simply matches nothing.

type JsonRecord = Record<string, unknown>;

/**
 * "This provider was never provisioned here", in the two shapes it arrives in.
 *
 * PostgREST answers a table that is not in its schema cache itself, without
 * ever reaching Postgres: HTTP 404 with code PGRST205, "Could not find the
 * table 'public.x' in the schema cache" (postgrest.org, Schema Cache group).
 * That is the shape hosted Supabase returns, and the first version of this
 * file matched only the Postgres codes — so on production, where migration 027
 * is deliberately not applied, the whole tab would have answered 502 and taken
 * the kill switch for a live channel down with it. Caught by review before it
 * shipped; PGRST205 is now the first thing checked.
 *
 * 42P01/42703 stay for a self-hosted PostgREST that does reach Postgres. The
 * loose "does not exist" substring is gone: it would have swallowed a mistyped
 * column in our own select and reported it as "not provisioned".
 */
const NOT_PROVISIONED_CODES = new Set(["PGRST205", "42P01", "42703"]);

type ProviderSpec = {
  provider: "wazzup" | "whatsapp_cloud";
  table: "wazzup_channels" | "whatsapp_cloud_numbers";
  keyColumn: "channel_id" | "phone_number_id";
  ledger: "wazzup_inbound_messages" | "whatsapp_cloud_inbound_messages";
};

const PROVIDERS: ProviderSpec[] = [
  {
    provider: "wazzup",
    table: "wazzup_channels",
    keyColumn: "channel_id",
    ledger: "wazzup_inbound_messages",
  },
  {
    provider: "whatsapp_cloud",
    table: "whatsapp_cloud_numbers",
    keyColumn: "phone_number_id",
    ledger: "whatsapp_cloud_inbound_messages",
  },
];

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

/**
 * A provider whose migration has not been applied is "not connected", not a
 * failure. Production runs ahead of hand-applied migrations by design here, and
 * a clinic opening its settings must not see an error because phase 2 has not
 * been provisioned for it yet.
 */
function isMissingRelation(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  if (NOT_PROVISIONED_CODES.has(readString(error.code))) return true;
  // Net for a PostgREST that reports the same condition without the code.
  return readString(error.message).toLowerCase().includes("schema cache");
}

/**
 * The last four characters of a channel key, for recognising which number is
 * connected without printing an identifier the operator has no use for.
 */
function maskKey(key: string): string {
  if (key.length <= 4) return key;
  return `…${key.slice(-4)}`;
}

type ChannelView = {
  id: string;
  provider: ProviderSpec["provider"];
  keyMasked: string;
  enabled: boolean;
  createdAt: string | null;
  leadsFiled: number;
  repeatsSeen: number;
  lastInboundAt: string | null;
};

type SupabaseServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

async function readProviderChannels(
  supabase: SupabaseServerClient,
  workspaceId: string,
  spec: ProviderSpec,
): Promise<{ channels: ChannelView[]; available: boolean }> {
  const { data, error } = await supabase
    .from(spec.table)
    .select("*")
    .eq("workspace_id", workspaceId);

  if (error) {
    if (isMissingRelation(error)) return { channels: [], available: false };
    throw new Error(`${spec.table}: ${error.message}`);
  }

  const rows = (Array.isArray(data) ? data : []).map(asRecord);
  if (rows.length === 0) return { channels: [], available: true };

  const channels = await Promise.all(
    rows.map(async (row) => {
      const key = readString(row[spec.keyColumn]);
      const activity = await readChannelActivity(supabase, workspaceId, spec, key);
      return {
        id: readString(row.id),
        provider: spec.provider,
        keyMasked: maskKey(key),
        enabled: row.enabled === true,
        createdAt: readString(row.created_at) || null,
        ...activity,
      };
    }),
  );

  return { available: true, channels };
}

/**
 * How much this channel has brought, asked of the database rather than counted
 * in code.
 *
 * The first version read the workspace's whole ledger with no limit and no
 * order and tallied it here. That is the trap this project already paid for in
 * the inbound dedup path: PostgREST caps a select at the project's max-rows
 * setting and, without ORDER BY, returns an arbitrary window — so a clinic past
 * that many messages would have seen its counters frozen and a "last inbound"
 * taken from whichever rows came back. Counts are now exact aggregates the
 * database computes, and the timestamp is one ordered row.
 *
 * Ledger rows still never reach the caller: `head: true` returns no body at
 * all, and the last-inbound query selects a single timestamp.
 */
async function readChannelActivity(
  supabase: SupabaseServerClient,
  workspaceId: string,
  spec: ProviderSpec,
  channelKey: string,
): Promise<{ leadsFiled: number; repeatsSeen: number; lastInboundAt: string | null }> {
  const countOf = async (kind: "created" | "repeat") => {
    const { count, error } = await supabase
      .from(spec.ledger)
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("channel_id", channelKey)
      .eq("kind", kind);
    if (error) {
      if (isMissingRelation(error)) return 0;
      throw new Error(`${spec.ledger}: ${error.message}`);
    }
    return typeof count === "number" ? count : 0;
  };

  const lastInbound = async () => {
    const { data, error } = await supabase
      .from(spec.ledger)
      .select("received_at")
      .eq("workspace_id", workspaceId)
      .eq("channel_id", channelKey)
      .order("received_at", { ascending: false })
      .limit(1);
    if (error) {
      if (isMissingRelation(error)) return null;
      throw new Error(`${spec.ledger}: ${error.message}`);
    }
    const rows = Array.isArray(data) ? data : [];
    return rows.length > 0 ? readString(asRecord(rows[0]).received_at) || null : null;
  };

  const [leadsFiled, repeatsSeen, lastInboundAt] = await Promise.all([
    countOf("created"),
    countOf("repeat"),
    lastInbound(),
  ]);

  return { leadsFiled, repeatsSeen, lastInboundAt };
}

async function listChannels(workspaceId: string, res: VercelResponse) {
  const supabase = getSupabaseServerClient();
  if (!supabase || !isUuid(workspaceId)) {
    return sendJson(res, 200, {
      success: true,
      mode: "demo",
      data: { channels: [], items: [], providers: [] },
    });
  }

  try {
    const results = await Promise.all(
      PROVIDERS.map(async (spec) => ({ spec, ...(await readProviderChannels(supabase, workspaceId, spec)) })),
    );

    return sendJson(res, 200, {
      success: true,
      mode: "supabase",
      data: {
        channels: results.flatMap((entry) => entry.channels),
        items: results.flatMap((entry) => entry.channels),
        // Which providers this database can serve at all — the interface uses
        // it to say "phase 2 is not provisioned" instead of "not connected".
        providers: results.map((entry) => ({ provider: entry.spec.provider, available: entry.available })),
      },
    });
  } catch (error) {
    // Security-2F honesty: a refused read is a failure, and the caller is told
    // so without the database's own words.
    console.warn(`[whatsapp-channels] list failed: ${error instanceof Error ? error.message : String(error)}`);
    return sendJson(res, 502, {
      success: false,
      error: "Не удалось загрузить каналы WhatsApp",
    });
  }
}

async function patchChannel(workspaceId: string, req: VercelRequest, res: VercelResponse) {
  const body = asRecord(req.body);
  const id = readString(body.id);
  const provider = readString(body.provider);
  const spec = PROVIDERS.find((entry) => entry.provider === provider);

  if (!spec || !isUuid(id)) {
    return sendJson(res, 400, { success: false, error: "Некорректный запрос" });
  }
  if (typeof body.enabled !== "boolean") {
    return sendJson(res, 400, { success: false, error: "Некорректный запрос" });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase || !isUuid(workspaceId)) {
    return sendJson(res, 503, { success: false, error: "Сервис временно недоступен" });
  }

  try {
    // The workspace filter is unconditional and is what makes an id from
    // another clinic match nothing rather than toggle their channel.
    const { data, error } = await supabase
      .from(spec.table)
      .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .select("id, enabled");

    if (error) throw new Error(error.message);

    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      // Either no such channel, or it belongs to someone else. The answer is
      // the same either way: nothing is disclosed about which.
      return sendJson(res, 404, { success: false, error: "Канал не найден" });
    }

    return sendJson(res, 200, {
      success: true,
      mode: "supabase",
      data: { item: { id: readString(asRecord(rows[0]).id), enabled: asRecord(rows[0]).enabled === true } },
    });
  } catch (error) {
    console.warn(`[whatsapp-channels] patch failed: ${error instanceof Error ? error.message : String(error)}`);
    return sendJson(res, 502, { success: false, error: "Не удалось изменить канал" });
  }
}

export async function handleWhatsAppChannels(req: VercelRequest, res: VercelResponse) {
  // The tenant comes from the context the router attached after verifying the
  // JWT and the membership. No context means the request was not authorized,
  // and every branch below then runs without a database.
  const context = readWorkspaceContext(req);
  const workspaceId = readString(context?.workspaceId);

  if (req.method === "GET") {
    return listChannels(workspaceId, res);
  }
  if (req.method === "PATCH") {
    return patchChannel(workspaceId, req, res);
  }
  return sendJson(res, 405, { success: false, error: "Method not allowed" });
}
