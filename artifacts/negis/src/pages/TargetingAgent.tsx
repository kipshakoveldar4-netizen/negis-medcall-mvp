import { useState, type CSSProperties } from "react";
import { Activity, BarChart3, BrainCircuit, FileText, Rocket } from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { apiUrl } from "@/lib/api";

type ApiSuccess<TData = unknown> = {
  success: true;
  mode: string;
  data: TData;
};

type ApiError = {
  success: false;
  error: string;
  details: string[];
};

type ApiResponse<TData = unknown> = ApiSuccess<TData> | ApiError;

type AnalyzeData = {
  creativeScore?: number;
  problems?: string[];
  recommendations?: string[];
  targetAudience?: Record<string, unknown>;
  campaignSettings?: Record<string, unknown>;
  budgetRecommendation?: Record<string, unknown>;
  expectedMetrics?: Record<string, unknown>;
  summary?: string;
};

type LaunchData = {
  campaignId?: string;
  status?: string;
  storageMode?: string;
  message?: string;
};

type ReportData = {
  campaignId?: string;
  report?: {
    status?: string;
    executiveSummary?: string;
    metrics?: Record<string, unknown>;
    insights?: string[];
    recommendations?: string[];
    nextSteps?: string[];
  };
};

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 10,
  border: "1px solid #E7ECF3",
  background: "#F8FAFC",
  color: "#0B1220",
  fontSize: 13,
  padding: "10px 12px",
  outline: "none",
};

const labelStyle: CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontSize: 11,
  fontWeight: 700,
  color: "#64748B",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const sectionTitleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "#0B1220",
  fontSize: 15,
  fontWeight: 800,
  marginBottom: 16,
};

const initialCreative = {
  clinicName: "Concept Clinic",
  niche: "cosmetology",
  city: "Astana",
  offer: "Free consultation and diagnostics",
  creativeText: "Free cosmetology consultation in Astana. Book your appointment on WhatsApp today.",
  targetAudience: "Women 25-45",
};

const initialLaunch = {
  campaignName: "Astana Cosmetology Free Consultation",
  budget: "300",
  objective: "leads",
};

function isApiError(response: ApiResponse): response is ApiError {
  return response.success === false;
}

async function requestJson<TData>(path: string, init?: RequestInit): Promise<ApiResponse<TData>> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return (await response.json()) as ApiResponse<TData>;
}

function Field({
  label,
  value,
  onChange,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  textarea?: boolean;
}) {
  return (
    <label>
      <span style={labelStyle}>{label}</span>
      {textarea ? (
        <textarea
          style={{ ...inputStyle, minHeight: 112, resize: "vertical" }}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input style={inputStyle} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

function ListBlock({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;

  return (
    <div className="neu-sm p-4">
      <p className="text-xs font-bold uppercase text-[#64748B] mb-3">{title}</p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item} className="text-sm text-[#334155] leading-relaxed">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value?: unknown }) {
  if (!value) return null;

  return (
    <div className="neu-sm p-4 min-w-0">
      <p className="text-xs font-bold uppercase text-[#64748B] mb-3">{title}</p>
      <pre className="text-xs text-[#334155] whitespace-pre-wrap break-words font-mono">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default function TargetingAgent() {
  const [creative, setCreative] = useState(initialCreative);
  const [launch, setLaunch] = useState(initialLaunch);
  const [reportCampaignId, setReportCampaignId] = useState("");
  const [analysis, setAnalysis] = useState<ApiSuccess<AnalyzeData> | null>(null);
  const [launchResult, setLaunchResult] = useState<ApiSuccess<LaunchData> | null>(null);
  const [report, setReport] = useState<ApiSuccess<ReportData> | null>(null);
  const [loading, setLoading] = useState<"health" | "analyze" | "launch" | "report" | null>(null);
  const [health, setHealth] = useState<ApiResponse | null>(null);

  const updateCreative = (key: keyof typeof initialCreative, value: string) => {
    setCreative((current) => ({ ...current, [key]: value }));
  };

  const updateLaunch = (key: keyof typeof initialLaunch, value: string) => {
    setLaunch((current) => ({ ...current, [key]: value }));
  };

  const handleApiError = (response: ApiResponse) => {
    if (isApiError(response)) {
      toast.error(response.error, {
        description: response.details.join(", ") || undefined,
      });
    }
  };

  const checkHealth = async () => {
    setLoading("health");
    try {
      const response = await requestJson("/api/targeting/health");
      setHealth(response);
      if (isApiError(response)) handleApiError(response);
      else toast.success("Targeting Agent is available");
    } catch {
      toast.error("Targeting Agent health check failed");
    } finally {
      setLoading(null);
    }
  };

  const analyzeCreative = async () => {
    setLoading("analyze");
    try {
      const response = await requestJson<AnalyzeData>("/api/targeting/analyze", {
        method: "POST",
        body: JSON.stringify(creative),
      });
      if (isApiError(response)) {
        handleApiError(response);
        return;
      }
      setAnalysis(response);
      toast.success("Creative analyzed");
    } catch {
      toast.error("Analyze request failed");
    } finally {
      setLoading(null);
    }
  };

  const launchCampaign = async () => {
    setLoading("launch");
    try {
      const response = await requestJson<LaunchData>("/api/targeting/launch", {
        method: "POST",
        body: JSON.stringify({
          ...creative,
          campaignName: launch.campaignName,
          budget: Number(launch.budget),
          objective: launch.objective,
          analysis: analysis?.data,
        }),
      });
      if (isApiError(response)) {
        handleApiError(response);
        return;
      }
      setLaunchResult(response);
      const createdCampaignId = response.data.campaignId?.trim();
      if (createdCampaignId) setReportCampaignId(createdCampaignId);
      toast.success("Pending campaign created");
    } catch {
      toast.error("Launch request failed");
    } finally {
      setLoading(null);
    }
  };

  const getReport = async () => {
    const campaignId = reportCampaignId.trim();

    if (!campaignId) {
      toast.error("Validation error", {
        description: "campaignId is required",
      });
      return;
    }

    setLoading("report");
    try {
      const response = await requestJson<ReportData>(
        `/api/targeting/reports/${encodeURIComponent(campaignId)}`,
      );
      if (isApiError(response)) {
        handleApiError(response);
        return;
      }
      setReport(response);
      toast.success("Report loaded");
    } catch {
      toast.error("Report request failed");
    } finally {
      setLoading(null);
    }
  };

  return (
    <PageLayout requireAuth={false}>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-2xl font-bold text-[#0B1220]">Targeting Agent</h2>
            <p className="text-sm text-[#64748B] mt-1">
              AI creative analysis, pending campaign drafts, and demo reports through MedCall Targeting Agent.
            </p>
          </div>
          <button
            className="neu-btn flex items-center gap-2 text-sm px-4 py-2"
            onClick={checkHealth}
            disabled={loading === "health"}
          >
            <Activity size={15} />
            {loading === "health" ? "Checking..." : "Check health"}
          </button>
        </div>

        {health && (
          <div className="neu-sm p-4 text-sm text-[#334155]">
            Health:{" "}
            {health.success ? (
              <span className="font-bold text-green-600">available ({health.mode})</span>
            ) : (
              <span className="font-bold text-red-500">{health.error}</span>
            )}
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <section className="neu-card p-6">
            <h3 style={sectionTitleStyle}>
              <BrainCircuit size={18} />
              Creative analysis
            </h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Clinic name" value={creative.clinicName} onChange={(value) => updateCreative("clinicName", value)} />
              <Field label="Niche" value={creative.niche} onChange={(value) => updateCreative("niche", value)} />
              <Field label="City" value={creative.city} onChange={(value) => updateCreative("city", value)} />
              <Field label="Offer" value={creative.offer} onChange={(value) => updateCreative("offer", value)} />
              <div className="md:col-span-2">
                <Field
                  label="Creative text"
                  value={creative.creativeText}
                  onChange={(value) => updateCreative("creativeText", value)}
                  textarea
                />
              </div>
              <div className="md:col-span-2">
                <Field
                  label="Target audience"
                  value={creative.targetAudience}
                  onChange={(value) => updateCreative("targetAudience", value)}
                />
              </div>
            </div>
            <button
              className="neu-btn-primary mt-5 flex items-center gap-2 text-sm px-5 py-2.5"
              onClick={analyzeCreative}
              disabled={loading === "analyze"}
            >
              <BrainCircuit size={15} />
              {loading === "analyze" ? "Analyzing..." : "Analyze creative"}
            </button>
          </section>

          <section className="neu-card p-6">
            <h3 style={sectionTitleStyle}>
              <Rocket size={18} />
              Pending campaign
            </h3>
            <div className="space-y-4">
              <Field
                label="Campaign name"
                value={launch.campaignName}
                onChange={(value) => updateLaunch("campaignName", value)}
              />
              <Field label="Budget" value={launch.budget} onChange={(value) => updateLaunch("budget", value)} />
              <Field
                label="Objective"
                value={launch.objective}
                onChange={(value) => updateLaunch("objective", value)}
              />
            </div>
            <button
              className="neu-btn-primary mt-5 flex items-center gap-2 text-sm px-5 py-2.5"
              onClick={launchCampaign}
              disabled={loading === "launch"}
            >
              <Rocket size={15} />
              {loading === "launch" ? "Creating..." : "Create campaign"}
            </button>

            {launchResult && (
              <div className="neu-sm p-4 mt-5 text-sm text-[#334155] space-y-2">
                <p>
                  Status: <span className="font-bold">{launchResult.data.status}</span>
                </p>
                <p>
                  Storage: <span className="font-bold">{launchResult.data.storageMode}</span>
                </p>
                <p className="break-all">
                  Campaign ID: <span className="font-mono">{launchResult.data.campaignId}</span>
                </p>
              </div>
            )}
          </section>
        </div>

        {analysis && (
          <section className="neu-card p-6">
            <h3 style={sectionTitleStyle}>
              <BarChart3 size={18} />
              Analysis result
            </h3>
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="neu-sm p-4">
                <p className="text-xs font-bold uppercase text-[#64748B] mb-2">Creative score</p>
                <p className="text-4xl font-black text-[#1A56DB]">{analysis.data.creativeScore ?? "-"}</p>
                <p className="text-sm text-[#64748B] mt-3 leading-relaxed">{analysis.data.summary}</p>
              </div>
              <ListBlock title="Problems" items={analysis.data.problems} />
              <ListBlock title="Recommendations" items={analysis.data.recommendations} />
              <JsonBlock title="Target audience" value={analysis.data.targetAudience} />
              <JsonBlock title="Campaign settings" value={analysis.data.campaignSettings} />
              <JsonBlock title="Budget recommendation" value={analysis.data.budgetRecommendation} />
              <JsonBlock title="Expected metrics" value={analysis.data.expectedMetrics} />
            </div>
          </section>
        )}

        <section className="neu-card p-6">
          <h3 style={sectionTitleStyle}>
            <FileText size={18} />
            Campaign report
          </h3>
          <div className="flex flex-col gap-3 md:flex-row">
            <input
              style={inputStyle}
              value={reportCampaignId}
              onChange={(event) => setReportCampaignId(event.target.value)}
              placeholder="campaignId"
            />
            <button
              className="neu-btn-primary flex items-center justify-center gap-2 text-sm px-5 py-2.5 shrink-0"
              onClick={getReport}
              disabled={loading === "report"}
            >
              <FileText size={15} />
              {loading === "report" ? "Loading..." : "Get report"}
            </button>
          </div>

          {report && (
            <div className="grid gap-4 lg:grid-cols-3 mt-5">
              <div className="neu-sm p-4">
                <p className="text-xs font-bold uppercase text-[#64748B] mb-2">Summary</p>
                <p className="text-sm text-[#334155] leading-relaxed">{report.data.report?.executiveSummary}</p>
              </div>
              <JsonBlock title="Metrics" value={report.data.report?.metrics} />
              <ListBlock title="Insights" items={report.data.report?.insights} />
              <ListBlock title="Recommendations" items={report.data.report?.recommendations} />
              <ListBlock title="Next steps" items={report.data.report?.nextSteps} />
            </div>
          )}
        </section>
      </div>
    </PageLayout>
  );
}
