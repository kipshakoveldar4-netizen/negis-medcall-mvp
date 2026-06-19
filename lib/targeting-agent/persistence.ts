import { getSupabaseServerClient } from "../supabase/server";
import type {
  LaunchCampaignPayload,
  TargetingAgentBody,
} from "./client";

type PersistenceMode = "demo" | "supabase";

type WorkspacePersistenceResult = {
  workspaceId: string;
  persistenceMode: PersistenceMode;
  warning?: string;
};

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

export async function persistWorkspaceIfAvailable(input: {
  workspaceName: string;
  ownerEmail: string;
}): Promise<WorkspacePersistenceResult> {
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return {
      workspaceId: DEMO_WORKSPACE_ID,
      persistenceMode: "demo",
    };
  }

  try {
    const { data, error } = await supabase
      .from("workspaces")
      .insert({
        name: input.workspaceName,
        owner_email: input.ownerEmail,
      })
      .select("id")
      .single();

    if (error) {
      throw new Error(error.message);
    }

    const workspaceId = readString(asRecord(data).id);
    if (!workspaceId) {
      throw new Error("Supabase did not return workspace id");
    }

    return {
      workspaceId,
      persistenceMode: "supabase",
    };
  } catch (error) {
    const warning = persistenceWarning("Workspace", error);
    console.warn(warning);

    return {
      workspaceId: DEMO_WORKSPACE_ID,
      persistenceMode: "demo",
      warning,
    };
  }
}

export async function persistTargetingCampaignIfAvailable(
  payload: LaunchCampaignPayload,
  responseBody: TargetingAgentBody,
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
  const workspaceId = readString(payload.workspaceId);
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

  try {
    const { error: campaignError } = await supabase
      .from("targeting_campaigns")
      .upsert(
        {
          id: campaignId,
          status: "pending",
          raw_payload: {
            source: "report-backfill",
            campaignId,
          },
        },
        { onConflict: "id", ignoreDuplicates: true },
      );

    if (campaignError) {
      throw new Error(campaignError.message);
    }

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
