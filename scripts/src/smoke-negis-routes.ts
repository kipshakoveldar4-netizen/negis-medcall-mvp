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
  await checkJsonEndpoint("/api/crm/ad-creative-upload", {
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
