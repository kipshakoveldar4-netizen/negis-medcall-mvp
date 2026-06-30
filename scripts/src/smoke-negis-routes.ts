import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ApiBody = {
  success?: boolean;
  mode?: string;
  error?: string;
  details?: string[];
  data?: unknown;
};

export {};

const baseUrl = (
  process.env.NEGIS_SMOKE_BASE_URL ||
  process.env.NEGIS_BASE_URL ||
  "http://localhost:5173"
).replace(/\/$/, "");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function assertSourceIncludes(source: string, expected: string, label: string) {
  if (!source.includes(expected)) {
    throw new Error(`AdsAutomation source is missing ${label}`);
  }
}

function assertSourceExcludes(source: string, forbidden: string, label: string) {
  if (source.includes(forbidden)) {
    throw new Error(`AdsAutomation source still contains ${label}`);
  }
}

async function checkAdsAutomationSource() {
  const source = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx"), "utf8");

  assertSourceIncludes(source, "publicURL", "publicURL normalization");
  assertSourceIncludes(source, "buildFrontendStoragePublicUrl(storagePath, storageBucket)", "publicUrl derivation from storagePath");
  assertSourceIncludes(source, "Техническая информация", "collapsed technical info block");
  assertSourceIncludes(source, "Перейти к подтверждению запуска", "step 5 launch confirmation button");
  assertSourceIncludes(source, "Назад к отчёту", "step 6 back to report button");
  assertSourceIncludes(source, 'imageUrl: creative?.fileType === "image" ? creativeUrl : ""', "imageUrl launch payload");
  assertSourceIncludes(source, 'videoUrl: creative?.fileType === "video" ? creativeUrl : ""', "videoUrl launch payload");
  assertSourceIncludes(source, "Загрузка не прошла. Попробуйте другой файл.", "failed upload message");
  assertSourceIncludes(source, "getting_signed_url", "signed URL status");
  assertSourceIncludes(source, "uploading_to_storage", "Storage upload status");
  assertSourceIncludes(source, "saving_metadata", "metadata save status");
  assertSourceIncludes(source, "setUploadStatus(\"failed\")", "failed upload state");
  assertSourceIncludes(source, "creativeCanContinue = Boolean(creative?.publicUrl)", "ready state requires publicUrl");
  assertSourceIncludes(source, "uploadToSignedUrl", "signed Supabase upload call");
  assertSourceIncludes(source, "/api/crm/ad-creatives/signed-upload", "signed upload endpoint");
  assertSourceIncludes(source, "/api/crm/ad-creatives", "metadata save endpoint");
  assertSourceIncludes(source, "signed_url", "signed upload metadata marker");
  assertSourceIncludes(source, "lastUploadError", "detailed upload error state");
  assertSourceIncludes(source, "VERCEL_FUNCTION_FILE_LIMIT_BYTES", "Vercel payload guard");
  assertSourceExcludes(source, "/api/crm/ad-creative-upload", "file upload endpoint in UI");
  assertSourceExcludes(source, "new FormData(", "multipart upload from UI");
  assertSourceExcludes(source, ".upload(storagePath, file", "anonymous Supabase upload call");
  assertSourceExcludes(source, "Файл загружается. Подождите несколько секунд.", "stale endless upload message");

  console.log("AdsAutomation source checks: ok");
}

async function checkMetaMarketingSource() {
  const source = await readFile(path.join(repoRoot, "lib", "meta", "marketing.ts"), "utf8");

  if (!source.includes("uploadMetaImageFromUrl")) {
    throw new Error("Meta marketing source is missing uploadMetaImageFromUrl");
  }
  if (!source.includes("/adimages")) {
    throw new Error("Meta marketing source is missing /adimages upload");
  }
  if (!source.includes("image_hash")) {
    throw new Error("Meta marketing source is missing image_hash creative flow");
  }
  if (!source.includes("MetaApiError")) {
    throw new Error("Meta marketing source is missing detailed Meta API errors");
  }

  console.log("Meta marketing source checks: ok");
}

async function checkHtmlRoute(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  if (!text.includes('<div id="root">')) {
    throw new Error(`${path} did not return the Negis app shell`);
  }

  console.log(`${path}: ok`);
}

async function checkTargetingHealth() {
  const response = await fetch(`${baseUrl}/api/targeting/health`);
  const text = await response.text();
  let body: ApiBody;

  try {
    body = JSON.parse(text) as ApiBody;
  } catch {
    throw new Error(`/api/targeting/health returned invalid JSON: ${text.slice(0, 120)}`);
  }

  if (!response.ok || body.success !== true) {
    const details = body.details?.join(", ");
    throw new Error(
      `/api/targeting/health failed: ${body.error || `HTTP ${response.status}`}${details ? ` (${details})` : ""}`,
    );
  }

  console.log(`/api/targeting/health: ok (${body.mode || "unknown"})`);
}

async function checkJsonEndpoint(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: ApiBody;

  try {
    body = JSON.parse(text) as ApiBody;
  } catch {
    throw new Error(`${path} returned invalid JSON: ${text.slice(0, 120)}`);
  }

  if (!response.ok || body.success !== true) {
    const details = body.details?.join(", ");
    throw new Error(`${path} failed: ${body.error || `HTTP ${response.status}`}${details ? ` (${details})` : ""}`);
  }

  console.log(`${path}: ok (${body.mode || "unknown"})`);
  return body;
}

async function checkJsonFailure(path: string, init: RequestInit, expectedText?: string) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: ApiBody;

  try {
    body = JSON.parse(text) as ApiBody;
  } catch {
    throw new Error(`${path} returned invalid JSON for failure check: ${text.slice(0, 120)}`);
  }

  if (response.ok && body.success !== false) {
    throw new Error(`${path} unexpectedly succeeded`);
  }

  const combined = [body.error, ...(body.details || [])].filter(Boolean).join(" ");
  if (expectedText && !combined.includes(expectedText)) {
    throw new Error(`${path} failed with unexpected message: ${combined}`);
  }

  console.log(`${path}: expected failure ok`);
  return body;
}

async function checkCrmEndpoint(path: string, payload: Record<string, unknown>) {
  await checkJsonEndpoint(`${path}?workspaceId=demo-workspace`);
  await checkJsonEndpoint(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      ...payload,
    }),
  });
}

async function main() {
  console.log(`Smoke testing Negis routes at ${baseUrl}`);
  await checkAdsAutomationSource();
  await checkMetaMarketingSource();
  for (const route of [
    "/dashboard",
    "/clients",
    "/appointments",
    "/booking",
    "/reception",
    "/leads",
    "/calls",
    "/tasks",
    "/chat",
    "/market",
    "/reports",
    "/admin",
    "/ads",
    "/ads-automation",
    "/ads-automation/history",
    "/targeting-agent",
    "/content-studio",
    "/login",
  ]) {
    await checkHtmlRoute(route);
  }
  await checkTargetingHealth();
  await checkJsonEndpoint("/api/crm/health");
  await checkJsonEndpoint("/api/crm/storage-health");
  await checkCrmEndpoint("/api/crm/clients", {
    name: "Smoke Client",
    phone: "+7 700 000 00 00",
    source: "smoke",
  });
  await checkCrmEndpoint("/api/crm/leads", {
    name: "Smoke Lead",
    phone: "+7 700 111 22 33",
    source: "smoke",
  });
  await checkCrmEndpoint("/api/crm/appointments", {
    client: "Smoke Client",
    phone: "+7 700 222 33 44",
    whatsapp: "+7 700 222 33 44",
    service: "Consultation",
    doctor: "Smoke Doctor",
    starts_at: new Date().toISOString(),
    durationMinutes: 60,
    status: "scheduled",
    source: "smoke",
  });
  await checkCrmEndpoint("/api/crm/tasks", {
    title: "Smoke task",
    status: "new",
  });
  await checkCrmEndpoint("/api/crm/chat", {
    dialog: "Smoke",
    author: "Smoke",
    text: "Smoke message",
  });
  await checkCrmEndpoint("/api/crm/staff", {
    name: "Smoke Staff",
    email: "smoke@example.com",
    role: "receptionist",
  });
  await checkCrmEndpoint("/api/crm/content-videos", {
    title: "Smoke content video",
    niche: "medical marketing",
  });
  await checkCrmEndpoint("/api/crm/admin-settings", {
    key: "clinic",
    value: {
      clinicName: "Smoke Clinic",
      city: "Astana",
    },
  });
  await checkCrmEndpoint("/api/crm/integration-statuses", {
    provider: "smoke",
    status: "configured",
  });
  await checkCrmEndpoint("/api/crm/ai-providers", {
    provider: "openai",
    purpose: "smoke",
    enabled: false,
    modelName: "smoke-model",
  });
  await checkCrmEndpoint("/api/crm/meta-accounts", {
    accountName: "Smoke Meta Account",
    status: "draft",
  });
  await checkCrmEndpoint("/api/crm/meta-launches", {
    campaignName: "Smoke Meta Launch",
    status: "draft",
  });
  await checkCrmEndpoint("/api/crm/ad-creatives", {
    fileName: "smoke-creative.jpg",
    fileType: "image",
    mimeType: "image/jpeg",
    fileSize: 2048,
    publicUrl: "https://example.com/smoke-creative.jpg",
    status: "uploaded",
  });
  const metadataSave = await checkJsonEndpoint("/api/crm/ad-creatives", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-direct-upload.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 6_700_000,
      storageBucket: "ad-creatives",
      storagePath: "demo-workspace/smoke-direct-upload.jpg",
      publicUrl: "https://example.com/smoke-direct-upload.jpg",
      status: "uploaded",
      metadata: {
        source: "ads-automation",
        uploadMode: "signed_url",
        signedUpload: true,
      },
    }),
  });
  const metadataAsset = (metadataSave.data || {}) as { publicUrl?: string; item?: { publicUrl?: string; storagePath?: string } };
  if (!metadataAsset.publicUrl && !metadataAsset.item?.publicUrl) {
    throw new Error("/api/crm/ad-creatives did not return publicUrl for metadata save");
  }
  if (!metadataAsset.item?.storagePath) {
    throw new Error("/api/crm/ad-creatives did not keep storagePath for metadata save");
  }
  await checkJsonFailure(
    "/api/crm/ad-creatives/signed-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-bad.gif",
        fileType: "image",
        mimeType: "image/gif",
        fileSize: 2048,
      }),
    },
    "Формат",
  );
  await checkJsonFailure(
    "/api/crm/ad-creatives/signed-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-too-large.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 10 * 1024 * 1024 + 1,
      }),
    },
    "10 MB",
  );
  await checkJsonFailure(
    "/api/crm/ad-creatives/signed-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-too-large.mp4",
        fileType: "video",
        mimeType: "video/mp4",
        fileSize: 100 * 1024 * 1024 + 1,
      }),
    },
    "100 MB",
  );
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const signedUpload = await checkJsonEndpoint("/api/crm/ad-creatives/signed-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-signed-upload.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 2048,
      }),
    });
    const signedData = (signedUpload.data || {}) as { storagePath?: string; publicUrl?: string; token?: string };
    if (!signedData.storagePath || !signedData.publicUrl || !signedData.token) {
      throw new Error("/api/crm/ad-creatives/signed-upload did not return storagePath/publicUrl/token");
    }
  } else {
    await checkJsonFailure(
      "/api/crm/ad-creatives/signed-upload",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "demo-workspace",
          fileName: "smoke-signed-upload.jpg",
          fileType: "image",
          mimeType: "image/jpeg",
          fileSize: 2048,
        }),
      },
      "SUPABASE_URL",
    );
  }
  const upload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-upload.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 2048,
      publicUrl: "https://example.com/smoke-upload.jpg",
      status: "uploaded",
    }),
  });
  const uploadedAsset = (upload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!uploadedAsset.publicUrl && !uploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not return publicUrl");
  }
  const snakeUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      file_name: "smoke-upload-snake.jpg",
      file_type: "image",
      mime_type: "image/jpeg",
      file_size: 2048,
      storage_bucket: "ad-creatives",
      storage_path: "demo-workspace/ads/smoke-upload-snake.jpg",
      public_url: "https://example.com/smoke-upload-snake.jpg",
      status: "uploaded",
    }),
  });
  const snakeUploadedAsset = (snakeUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!snakeUploadedAsset.publicUrl && !snakeUploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not normalize public_url to publicUrl");
  }
  const urlUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-upload-url.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 2048,
      storageBucket: "ad-creatives",
      storagePath: "demo-workspace/ads/smoke-upload-url.jpg",
      url: "https://example.com/smoke-upload-url.jpg",
      status: "uploaded",
    }),
  });
  const urlUploadedAsset = (urlUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!urlUploadedAsset.publicUrl && !urlUploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not normalize url to publicUrl");
  }
  const publicURLUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-upload-public-url.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 2048,
      storageBucket: "ad-creatives",
      storagePath: "demo-workspace/ads/smoke-upload-public-url.jpg",
      publicURL: "https://example.com/smoke-upload-public-url.jpg",
      status: "uploaded",
    }),
  });
  const publicURLUploadedAsset = (publicURLUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!publicURLUploadedAsset.publicUrl && !publicURLUploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not normalize publicURL to publicUrl");
  }
  if (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) {
    const derivedUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-upload-derived.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 2048,
        storageBucket: "ad-creatives",
        storagePath: "demo-workspace/ads/smoke-upload-derived.jpg",
        status: "uploaded",
      }),
    });
    const derivedUploadedAsset = (derivedUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
    if (!derivedUploadedAsset.publicUrl && !derivedUploadedAsset.asset?.publicUrl) {
      throw new Error("/api/crm/ad-creative-upload did not derive publicUrl from storagePath");
    }
  }
  await checkJsonFailure(
    "/api/crm/ad-creative-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-upload-missing-url.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 2048,
        status: "demo",
      }),
    },
    "публичную ссылку",
  );
  await checkJsonEndpoint("/api/crm/ad-creative-meta-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-video.mp4",
      fileType: "video",
      mimeType: "video/mp4",
      publicUrl: "https://example.com/smoke-video.mp4",
      dryRun: true,
    }),
  });
  await checkJsonEndpoint("/api/crm/ads-ai-fill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      creativeType: "image",
      creativeUrl: "https://example.com/smoke-creative.jpg",
      service: "Consultation",
      city: "Astana",
      leadDestination: "whatsapp",
      destinationValue: "+77000000000",
      dailyBudget: 20,
      offer: "Consultation",
      knownAudience: "Women 25-55",
      restrictions: "Safe medical wording",
    }),
  });
  await checkJsonEndpoint("/api/crm/meta-validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      dryRun: true,
    }),
  });
  await checkJsonFailure(
    "/api/crm/meta-launch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        campaignName: "Smoke Meta Campaign missing creative URL",
        objective: "OUTCOME_LEADS",
        statusMode: "PAUSED",
        dailyBudget: 20,
        totalBudget: 140,
        currency: "USD",
        city: "Astana",
        targetAudience: "Women 25-55",
        primaryText: "Professional consultation in Astana. Book a specialist consultation.",
        headline: "Consultation in Astana",
        description: "Book a consultation with a specialist.",
        cta: "LEARN_MORE",
        landingUrl: "https://example.com",
        creativeType: "image",
        complianceConfirmed: true,
        manualApprovalConfirmed: true,
        dryRun: false,
      }),
    },
    "Креатив",
  );
  const launch = await checkJsonEndpoint("/api/crm/meta-launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      campaignName: "Smoke Meta Campaign",
      objective: "OUTCOME_LEADS",
      statusMode: "PAUSED",
      dailyBudget: 20,
      totalBudget: 140,
      currency: "USD",
      city: "Astana",
      targetAudience: "Women 25-55",
      primaryText: "Professional consultation in Astana. Book a specialist consultation.",
      headline: "Consultation in Astana",
      description: "Book a consultation with a specialist.",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      imageUrl: "https://example.com/smoke-creative.jpg",
      creativeType: "image",
      creativeUrl: "https://example.com/smoke-creative.jpg",
      complianceConfirmed: true,
      manualApprovalConfirmed: true,
      dryRun: true,
    }),
  });
  const launchData = (launch.data || {}) as { metaCampaignId?: string };
  await checkJsonEndpoint(`/api/crm/meta-status?campaignId=${encodeURIComponent(launchData.metaCampaignId || "dryrun_campaign_smoke")}`);
  await checkCrmEndpoint("/api/crm/release-checks", {
    checkKey: "smoke-release",
    status: "passed",
    notes: "Smoke test",
  });
  await checkJsonEndpoint("/api/content-studio/videos");
  await checkJsonEndpoint("/api/content-studio/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Smoke content studio video",
      niche: "medical marketing",
      goal: "book more appointments",
    }),
  });
  await checkJsonEndpoint("/api/content-studio/generate-script", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      niche: "medical marketing",
      goal: "book more appointments",
      audience: "clinic owners",
      style: "expert",
      duration: "30-45 seconds",
    }),
  });
  await checkJsonEndpoint("/api/content-studio/generate-avatar-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      style: "expert",
    }),
  });
  await checkJsonEndpoint("/api/content-studio/generate-tapnow-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      niche: "medical marketing",
      goal: "book more appointments",
    }),
  });
  await checkJsonEndpoint("/api/content-studio/send-telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      hook: "Clinic leads need fast follow-up",
      script: "Demo script",
      caption: "Demo caption",
      hashtags: ["#crm", "#ai"],
    }),
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
