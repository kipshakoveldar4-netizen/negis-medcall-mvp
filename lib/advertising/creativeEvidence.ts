import {
  normalizeAdvertisingContentApproval,
  type AdvertisingContentApproval,
} from "./campaignBrief";

export type CreativeEvidenceAvailability =
  | "available"
  | "not_synced"
  | "empty"
  | "running"
  | "failed"
  | "unavailable";

export type CreativeEvidenceLaunchInput = {
  id: string;
  campaignName: string;
  createdAt: string;
  contentApproval?: unknown;
};

export type CreativeEvidenceInsightsInput = {
  metaCampaignLaunchId: string;
  availability: CreativeEvidenceAvailability;
  coveredDateStart: string | null;
  coveredDateStop: string | null;
  latestFetchedAt: string | null;
  rowCount: number;
  spendByCurrency: Array<{
    currency: string;
    currencyExponent: number;
    spendMinor: string;
  }>;
  impressions: string;
  clicks: string;
  inlineLinkClicks: string;
  metaLeads: string | null;
};

export type CreativeEvidenceItem = {
  metaCampaignLaunchId: string;
  campaignName: string;
  createdAt: string;
  approval: AdvertisingContentApproval;
  insights: CreativeEvidenceInsightsInput | null;
};

export type CreativeExperimentGroup = {
  packageId: string;
  items: CreativeEvidenceItem[];
  reviewState: "same_period" | "partial" | "not_ready";
  coveredDateStart: string | null;
  coveredDateStop: string | null;
};

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasUsableInsights(
  insights: CreativeEvidenceInsightsInput | null,
): insights is CreativeEvidenceInsightsInput {
  return Boolean(
    insights
      && insights.availability === "available"
      && insights.rowCount > 0
      && insights.coveredDateStart
      && insights.coveredDateStop,
  );
}

export function buildCreativeExperimentGroups(
  launches: CreativeEvidenceLaunchInput[],
  insightsSummaries: CreativeEvidenceInsightsInput[],
): CreativeExperimentGroup[] {
  const insightsByLaunch = new Map(
    insightsSummaries.map((summary) => [summary.metaCampaignLaunchId, summary]),
  );
  const packages = new Map<string, Map<string, CreativeEvidenceItem>>();

  for (const launch of launches) {
    const approval = normalizeAdvertisingContentApproval(launch.contentApproval);
    if (
      !launch.id
      || !approval?.packageId
      || approval.copyMatchesLaunch !== true
    ) {
      continue;
    }

    const variants = packages.get(approval.packageId) || new Map<string, CreativeEvidenceItem>();
    const candidate: CreativeEvidenceItem = {
      metaCampaignLaunchId: launch.id,
      campaignName: launch.campaignName,
      createdAt: launch.createdAt,
      approval,
      insights: insightsByLaunch.get(launch.id) || null,
    };
    const current = variants.get(approval.variantId);
    if (!current || timestamp(candidate.createdAt) > timestamp(current.createdAt)) {
      variants.set(approval.variantId, candidate);
    }
    packages.set(approval.packageId, variants);
  }

  const groups: CreativeExperimentGroup[] = [];
  for (const [packageId, variants] of packages) {
    if (variants.size < 2) continue;
    const items = [...variants.values()].sort(
      (left, right) => timestamp(right.createdAt) - timestamp(left.createdAt),
    );
    const usable = items.flatMap((item) => (
      hasUsableInsights(item.insights) ? [{ item, insights: item.insights }] : []
    ));
    const rangeKeys = new Set(
      usable.map(({ insights }) => `${insights.coveredDateStart}:${insights.coveredDateStop}`),
    );
    const samePeriod = usable.length === items.length && rangeKeys.size === 1;

    groups.push({
      packageId,
      items,
      reviewState: samePeriod ? "same_period" : usable.length > 0 ? "partial" : "not_ready",
      coveredDateStart: samePeriod ? usable[0].insights.coveredDateStart : null,
      coveredDateStop: samePeriod ? usable[0].insights.coveredDateStop : null,
    });
  }

  return groups.sort((left, right) => {
    const leftLatest = Math.max(...left.items.map((item) => timestamp(item.createdAt)));
    const rightLatest = Math.max(...right.items.map((item) => timestamp(item.createdAt)));
    return rightLatest - leftLatest;
  });
}
