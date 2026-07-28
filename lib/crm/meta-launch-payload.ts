import {
  buildMetaAdSetPayload,
  buildMetaCampaignPayload,
  buildMetaTargetingDebug,
  resolveVideoThumbnailUrl,
  type MetaTargetingResolution,
} from "../meta/marketing";

// Security-2A — pure Meta launch payload boundary.
//
// This module is the single runtime source of truth for the campaign / ad set /
// creative / ad payload preview that /api/crm/meta-launch returns for a dry run
// and records for a real launch. It was moved here verbatim from
// lib/crm/server.ts so the Meta safety invariants (PAUSED, Instagram-only
// placements, WhatsApp destination, billing_event, dry-run shape) can be
// asserted without an HTTP request.
//
// That matters because Security-2B makes unauthenticated /api/crm/* return 401:
// the HTTP smoke assertions that cover these invariants today would otherwise
// disappear along with the open endpoint.
//
// Purity contract, enforced by scripts/src/medina-meta-launch-payload.test.ts:
// no Supabase, no Meta API, no process.env, no Date.now, no randomness, no
// mutation of the input. The one environment-dependent value the original code
// read directly, isMetaVideoLaunchEnabled(), is passed in by the caller instead.

export type MetaLaunchPayloadInput = {
  campaignName: string;
  objective: string;
  statusMode: string;
  dailyBudgetMinor: number;
  totalBudgetMinor: number;
  currency: string;
  primaryText: string;
  headline: string;
  description: string;
  cta: string;
  landingUrl: string;
  imageUrl: string;
  creativeUrl: string;
  creativeType: string;
  videoUrl: string;
  videoId: string;
  thumbnailUrl: string;
  startDate: string;
  endDate: string;
  city: string;
  selectedCityId: string;
  selectedCityLabelRu: string;
  selectedCityCanonicalName: string;
  audienceLabel: string;
  launchTimestamp: string;
  adSetName: string;
  creativeName: string;
  adName: string;
  metaCityKey: string;
  astanaCityKey: string;
  instagramActorId: string;
  mimeType: string;
  fileName: string;
  targetingResolution?: MetaTargetingResolution;
};

export type MetaLaunchPayloadOptions = {
  usesInstagramActor?: boolean;
  instagramActorFallback?: boolean;
  imageUploadMode?: "adimages" | "picture_url";
  imageHash?: boolean;
  pictureUrl?: boolean;
  imageUploadCapabilityFallback?: boolean;
  omitInstagramPositions?: boolean;
  videoId?: string;
  videoUploadMode?: string;
  videoProcessingStatus?: string;
  videoWarnings?: string[];
  /**
   * Replaces the direct isMetaVideoLaunchEnabled() call the original code made.
   * The caller reads the environment; this module stays deterministic.
   */
  videoLaunchEnabled?: boolean;
};

export function buildMetaLaunchPayloadPreview(
  launch: MetaLaunchPayloadInput,
  campaignId = "META_CAMPAIGN_ID",
  creativeOptions: MetaLaunchPayloadOptions = {},
): Record<string, unknown> {
  const videoLaunchEnabled = Boolean(creativeOptions.videoLaunchEnabled);
  const assetFileType = launch.creativeType === "video" ? "video" : "image";
  const usesLinkData = assetFileType === "image";
  const usesVideoData = assetFileType === "video";
  const imageHashExpected = usesLinkData && Boolean(launch.imageUrl || launch.creativeUrl);
  const imageUploadMode = usesLinkData ? creativeOptions.imageUploadMode || "adimages" : undefined;
  const imageUploadCapabilityFallback = Boolean(creativeOptions.imageUploadCapabilityFallback);
  const pictureUrlExpected =
    usesLinkData && (creativeOptions.pictureUrl ?? imageUploadMode === "picture_url");
  const campaign = buildMetaCampaignPayload({
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
    imageUrl: assetFileType === "image" ? launch.imageUrl || launch.creativeUrl : "",
    creativeType: launch.creativeType,
    videoUrl: assetFileType === "video" ? launch.videoUrl || launch.creativeUrl : "",
    videoId: assetFileType === "video" ? launch.videoId : "",
    thumbnailUrl: launch.thumbnailUrl,
    startTime: launch.startDate,
    endTime: launch.endDate || undefined,
    city: launch.city,
    selectedCityId: launch.selectedCityId,
    selectedCityLabelRu: launch.selectedCityLabelRu,
    selectedCityCanonicalName: launch.selectedCityCanonicalName,
    audienceLabel: launch.audienceLabel,
    launchTimestamp: launch.launchTimestamp,
    adSetName: launch.adSetName,
    creativeName: launch.creativeName,
    adName: launch.adName,
    metaCityKey: launch.metaCityKey,
    astanaCityKey: launch.astanaCityKey,
    targetingResolution: launch.targetingResolution,
    omitInstagramPositions: creativeOptions.omitInstagramPositions,
  });

  const adSet = buildMetaAdSetPayload({
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
    imageUrl: assetFileType === "image" ? launch.imageUrl || launch.creativeUrl : "",
    creativeType: launch.creativeType,
    videoUrl: assetFileType === "video" ? launch.videoUrl || launch.creativeUrl : "",
    videoId: assetFileType === "video" ? launch.videoId : "",
    thumbnailUrl: launch.thumbnailUrl,
    startTime: launch.startDate,
    endTime: launch.endDate || undefined,
    campaignId,
    city: launch.city,
    selectedCityId: launch.selectedCityId,
    selectedCityLabelRu: launch.selectedCityLabelRu,
    selectedCityCanonicalName: launch.selectedCityCanonicalName,
    audienceLabel: launch.audienceLabel,
    launchTimestamp: launch.launchTimestamp,
    adSetName: launch.adSetName,
    creativeName: launch.creativeName,
    adName: launch.adName,
    metaCityKey: launch.metaCityKey,
    astanaCityKey: launch.astanaCityKey,
    targetingResolution: launch.targetingResolution,
    omitInstagramPositions: creativeOptions.omitInstagramPositions,
  });
  const targetingDebug = buildMetaTargetingDebug({
    resolution: launch.targetingResolution,
    omitInstagramPositions: creativeOptions.omitInstagramPositions,
  });

  return {
    campaign,
    adSet: {
      ...adSet,
      targetingDebug,
      placementsMode: "instagram_only",
    },
    creative: {
      name: launch.creativeName,
      asset: { fileType: assetFileType },
      objectStorySpecType: usesLinkData ? "link_data" : "video_data",
      imageUploadMode,
      imageHash: creativeOptions.imageHash ?? (imageUploadMode === "adimages" ? imageHashExpected : false),
      pictureUrl: pictureUrlExpected,
      imageUploadCapabilityFallback,
      usesVideoData,
      usesLinkData,
      videoLaunchEnabled,
      metaVideoLaunchStatus: assetFileType === "video" ? (videoLaunchEnabled ? "experimental" : "soon") : "not_applicable",
      videoDataHasImageUrl:
        assetFileType === "video"
          ? Boolean(resolveVideoThumbnailUrl({ thumbnailUrl: launch.thumbnailUrl, videoUrl: launch.videoUrl || launch.creativeUrl }))
          : false,
      video: {
        mimeType: assetFileType === "video" ? launch.mimeType || "" : "",
        fileName: assetFileType === "video" ? launch.fileName || "" : "",
        uploadMode: assetFileType === "video" ? creativeOptions.videoUploadMode || "" : "",
        videoId: assetFileType === "video" ? Boolean(creativeOptions.videoId || launch.videoId) : false,
        processingStatus: assetFileType === "video" ? creativeOptions.videoProcessingStatus || "" : "",
        launchEnabled: assetFileType === "video" ? videoLaunchEnabled : false,
        thumbnailUrl: assetFileType === "video" ? Boolean(resolveVideoThumbnailUrl({ thumbnailUrl: launch.thumbnailUrl, videoUrl: launch.videoUrl || launch.creativeUrl })) : false,
        thumbnailSource: assetFileType === "video" && launch.thumbnailUrl ? "auto_frame" : "",
        warnings: assetFileType === "video" ? creativeOptions.videoWarnings || [] : [],
      },
      usesInstagramActor: creativeOptions.usesInstagramActor ?? Boolean(launch.instagramActorId),
      instagramActorFallback: creativeOptions.instagramActorFallback ?? false,
    },
    ad: {
      name: launch.adName,
      status: launch.statusMode,
    },
    launchTimestamp: launch.launchTimestamp,
    budgetLevel: "adset",
    warnings: [launch.targetingResolution?.warning || ""].filter(Boolean),
  };
}
