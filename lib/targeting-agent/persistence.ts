import { getSupabaseServerClient } from "../supabase/server";
import type {
  LaunchCampaignPayload,
  TargetingAgentBody,
} from "./client";

type PersistenceMode = "demo" | "supabase";

const DEMO_WORKSPACE_ID = "demo-workspace";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function persistenceWarning(scope: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${scope} Supabase persistence skipped: ${detail}`;
}

// Commercial-3B: the workspace insert that used to live here is gone.
//
// It existed for /api/auth/register, which took an unauthenticated POST and
// created a tenant for anyone who asked. That route is disabled, and leaving the
// function behind would leave a loaded gun: the next caller to reach for it
// would create a clinic with no verified owner, which is the whole thing the
// enrollment flow exists to prevent. A real provisioning path has to write the
// workspace and its owner membership together, against a verified identity.

export async function persistTargetingCampaignIfAvailable(
  payload: LaunchCampaignPayload,
  responseBody: TargetingAgentBody,
  /**
   * Security-2D: the verified workspace from the route guard. It used to be read
   * off the request body, which on a service-role client meant an anonymous
   * caller could file a campaign under any clinic.
   */
  verifiedWorkspaceId?: string,
): Promise<void> {
  if (responseBody.success !== true) {
    return;
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return;
  }

  const responseData = asRecord(responseBody.data);
  const campaignId = readString(responseData.campaignId);
  const workspaceId = readString(verifiedWorkspaceId);
  const budget = readNumber(payload.budget);
  const row: Record<string, unknown> = {
    campaign_name: readString(payload.campaignName),
    niche: readString(payload.niche),
    city: readString(payload.city),
    offer: readString(payload.offer),
    budget,
    status: readString(responseData.status) || "pending",
    raw_payload: {
      request: payload,
      response: responseBody,
    },
  };

  if (isUuid(campaignId)) {
    row.id = campaignId;
  }

  if (isUuid(workspaceId)) {
    row.workspace_id = workspaceId;
  }

  try {
    const query = isUuid(campaignId)
      ? supabase.from("targeting_campaigns").upsert(row, { onConflict: "id" })
      : supabase.from("targeting_campaigns").insert(row);
    const { error } = await query;

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    console.warn(persistenceWarning("Targeting campaign", error));
  }
}

/**
 * Security-2E: a targeting report is addressed by campaign id alone, so the id
 * has to be checked against the caller's workspace before the agent is asked
 * for anything.
 *
 * Security-2D put a token in front of the report routes but left the campaign
 * id unchecked, which meant any member holding view_marketing in any workspace
 * could read another clinic's campaign name, city, offer, budget, insights and
 * recommendations — and file a targeting_reports row against that clinic's
 * campaign, since reports inherit their tenancy from campaign_id and nothing
 * else.
 *
 * A campaign with no workspace_id belongs to no one and is treated as foreign:
 * the launch route has stamped the verified workspace on every row it writes
 * since Security-2D, so a null there is either pre-Security-2D residue or the
 * report-backfill path that no longer exists.
 */
export async function campaignBelongsToWorkspace(
  campaignId: string,
  workspaceId: string,
): Promise<boolean> {
  if (!isUuid(campaignId) || !isUuid(workspaceId)) {
    return false;
  }

  const supabase = getSupabaseServerClient();
  // Unreachable in practice: the route guard needs the same client to resolve
  // membership, so a caller cannot get this far without one. Refusing rather
  // than assuming keeps the failure closed if that ever stops being true.
  if (!supabase) {
    return false;
  }

  try {
    const { data, error } = await supabase
      .from("targeting_campaigns")
      .select("workspace_id")
      .eq("id", campaignId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    return isUuid(asRecord(data).workspace_id);
  } catch (error) {
    console.warn(persistenceWarning("Targeting campaign ownership", error));
    return false;
  }
}

export async function persistTargetingReportIfAvailable(
  campaignId: string,
  responseBody: TargetingAgentBody,
): Promise<void> {
  if (responseBody.success !== true || !isUuid(campaignId)) {
    return;
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return;
  }

  const responseData = asRecord(responseBody.data);
  const report = asRecord(responseData.report);

  // Security-2E: the report-backfill upsert that used to stand here is gone.
  //
  // It created a targeting_campaigns row with no workspace_id whenever a report
  // arrived for an unknown campaign — a tenant-less row, and the same loaded
  // gun the workspace insert above was removed for. The report routes now
  // refuse a campaign that does not already belong to the caller, so the
  // campaign always exists by the time this runs and the upsert could only
  // ever fire on a path that is no longer reachable.
  try {
    const { error } = await supabase.from("targeting_reports").insert({
      campaign_id: campaignId,
      summary: readString(report.executiveSummary) || readString(report.summary),
      metrics: report.metrics ?? {},
      insights: report.insights ?? [],
      recommendations: report.recommendations ?? [],
      raw_payload: responseBody,
    });

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    console.warn(persistenceWarning("Targeting report", error));
  }
}
