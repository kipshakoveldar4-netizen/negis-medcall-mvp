type ApiSuccess<TData = unknown> = {
  success: true;
  mode: string;
  data: TData;
};

export {};

type ApiResponse<TData = unknown> =
  | ApiSuccess<TData>
  | {
      success: false;
      error: string;
      details: string[];
    };

const baseUrl = (process.env.NEGIS_TARGETING_PROXY_URL || "http://localhost:3000").replace(/\/$/, "");

// Security-2D: /api/targeting/* writes targeting_campaigns and targeting_reports
// on the service-role client, so it is authenticated now. This script exercises
// the real proxy, which means it needs a real session: export a workspace member's
// access token as NEGIS_VERIFICATION_TOKEN before running it.
const accessToken = (process.env.NEGIS_VERIFICATION_TOKEN || "").trim();

async function request<TData>(path: string, init?: RequestInit): Promise<ApiSuccess<TData>> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as ApiResponse<TData>;

  if (!response.ok || body.success === false) {
    const message =
      body.success === false
        ? `${body.error}: ${body.details.join(", ")}`
        : `HTTP ${response.status}`;
    throw new Error(`${path} failed: ${message}`);
  }

  return body;
}

async function main() {
  console.log(`Testing Targeting Agent proxy at ${baseUrl}`);

  if (!accessToken) {
    console.log(
      "Skipped: /api/targeting/* requires an authenticated workspace member since Security-2D. " +
        "Set NEGIS_VERIFICATION_TOKEN to a member's access token to run this suite.",
    );
    return;
  }

  const health = await request("/api/targeting/health");
  console.log(`health: ${health.success ? health.mode : "failed"}`);

  const analyze = await request<{ creativeScore?: number }>("/api/targeting/analyze", {
    method: "POST",
    body: JSON.stringify({
      clinicName: "Concept Clinic",
      niche: "cosmetology",
      city: "Astana",
      offer: "Free consultation and diagnostics",
      creativeText: "Free cosmetology consultation in Astana. Book your appointment on WhatsApp today.",
      targetAudience: "Women 25-45",
    }),
  });
  console.log(`analyze: score=${analyze.data.creativeScore ?? "n/a"}`);

  const launch = await request<{ campaignId: string; status: string }>("/api/targeting/launch", {
    method: "POST",
    body: JSON.stringify({
      clinicName: "Concept Clinic",
      campaignName: "Astana Cosmetology Free Consultation",
      city: "Astana",
      budget: 300,
      objective: "leads",
      offer: "Free consultation and diagnostics",
    }),
  });
  console.log(`launch: ${launch.data.status} ${launch.data.campaignId}`);

  const report = await request<{ campaignId: string }>(
    `/api/targeting/report?campaignId=${encodeURIComponent(launch.data.campaignId)}`,
  );
  console.log(`report: ${report.data.campaignId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
