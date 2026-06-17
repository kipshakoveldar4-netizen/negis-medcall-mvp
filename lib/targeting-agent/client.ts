export type TargetingAgentSuccess<TData = unknown> = {
  success: true;
  mode: string;
  data: TData;
};

export type TargetingAgentErrorBody = {
  success: false;
  error: string;
  details: string[];
};

export type TargetingAgentBody<TData = unknown> =
  | TargetingAgentSuccess<TData>
  | TargetingAgentErrorBody;

export type TargetingAgentResult<TData = unknown> = {
  status: number;
  body: TargetingAgentBody<TData>;
};

export type AnalyzeCreativePayload = {
  clinicName: string;
  niche: string;
  city: string;
  offer: string;
  creativeText: string;
  targetAudience?: string;
  [key: string]: unknown;
};

export type LaunchCampaignPayload = {
  clinicName: string;
  campaignName: string;
  city: string;
  budget: number;
  objective: string;
  [key: string]: unknown;
};

const unavailableBody: TargetingAgentErrorBody = {
  success: false,
  error: "Targeting Agent unavailable",
  details: [],
};

function readTargetingAgentUrl(): string {
  return (process.env.TARGETING_AGENT_URL || "http://localhost:3001").replace(/\/$/, "");
}

function jsonHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const apiKey = process.env.TARGETING_AGENT_API_KEY?.trim();
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  return headers;
}

function normalizeErrorBody(value: unknown): TargetingAgentErrorBody {
  if (value && typeof value === "object") {
    const body = value as Partial<TargetingAgentErrorBody>;
    if (body.success === false && typeof body.error === "string") {
      return {
        success: false,
        error: body.error,
        details: Array.isArray(body.details) ? body.details.map(String) : [],
      };
    }
  }

  return unavailableBody;
}

function normalizeBody<TData>(value: unknown): TargetingAgentBody<TData> {
  if (value && typeof value === "object") {
    const body = value as TargetingAgentBody<TData>;
    if (body.success === true || body.success === false) {
      return body;
    }
  }

  return unavailableBody;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function validateRequiredFields(payload: unknown, fields: string[]): string[] {
  if (!payload || typeof payload !== "object") {
    return ["Request body must be a JSON object"];
  }

  const record = payload as Record<string, unknown>;
  return fields
    .filter((field) => {
      const value = record[field];
      if (typeof value === "string") {
        return value.trim().length === 0;
      }

      return value === undefined || value === null;
    })
    .map((field) => `${field} is required`);
}

export class TargetingAgentClient {
  constructor(private readonly baseUrl = readTargetingAgentUrl()) {}

  async healthCheck(): Promise<TargetingAgentResult> {
    return this.request("/health", { method: "GET" });
  }

  async analyzeCreative(payload: AnalyzeCreativePayload): Promise<TargetingAgentResult> {
    return this.request("/analyze", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async launchCampaign(payload: LaunchCampaignPayload): Promise<TargetingAgentResult> {
    return this.request("/launch", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getCampaignReport(campaignId: string): Promise<TargetingAgentResult> {
    return this.request(`/reports/${encodeURIComponent(campaignId)}`, { method: "GET" });
  }

  private async request(path: string, init: RequestInit): Promise<TargetingAgentResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...jsonHeaders(),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const body = await readJson(response);

      return {
        status: response.status,
        body: response.ok ? normalizeBody(body) : normalizeErrorBody(body),
      };
    } catch {
      return {
        status: 503,
        body: unavailableBody,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const targetingAgentClient = new TargetingAgentClient();
