import test from "node:test";

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

// Reported as a real skip rather than a silent early return.
//
// This suite drives the live Railway agent through the deployed proxy, so it
// needs both a running proxy and a workspace member's session. Without them the
// old script printed a line and exited 0 — indistinguishable from a pass in a
// normal run, which made a coverage hole look like coverage. As a node:test
// skip it shows up in the TAP output and in the "skipped" count, so anyone
// reading a run sees that this suite did not check anything.
//
// The authorization half of these routes is covered without the network:
// test:api-surface-authorization S14 and S15 drive the real handlers with a
// mocked auth endpoint and assert the agent is never called before the token is
// verified. What is uncovered here is the live integration.
const skipReason = accessToken
  ? undefined
  : "needs NEGIS_VERIFICATION_TOKEN (a workspace member's access token) and a reachable proxy";

test("targeting agent proxy round trip", { skip: skipReason }, async () => {
  console.log(`Testing Targeting Agent proxy at ${baseUrl}`);

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
});
