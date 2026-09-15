import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = path.join(repoRoot, "lib", "advertising", "assistant.ts");
const imported = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);

type Input = {
  launchLoadState: "loading" | "ready" | "error";
  createdLaunches: number;
  failedLaunches: number;
  processingLaunches: number;
  insightsAccess: "idle" | "checking" | "ready" | "required" | "forbidden" | "error";
  campaignsWithInsights: number;
  insightsEmpty: number;
  insightsRunning: number;
  insightsNotSynced: number;
  creativeTestsComparable?: number;
  creativeTestsIncomplete?: number;
  crmAccess: "idle" | "checking" | "ready" | "required" | "forbidden" | "error";
  unattributedLeads: number;
  paidUnattributedDeals: number;
};

type Brief = {
  reason: string;
  title: string;
  text: string;
  actionLabel?: string;
  href?: string;
};

const assistant = ((imported as { default?: unknown }).default ?? imported) as {
  buildAdvertisingAssistantBrief(input: Input): Brief;
};

const readyInput: Input = {
  launchLoadState: "ready",
  createdLaunches: 2,
  failedLaunches: 0,
  processingLaunches: 0,
  insightsAccess: "ready",
  campaignsWithInsights: 1,
  insightsEmpty: 0,
  insightsRunning: 0,
  insightsNotSynced: 0,
  creativeTestsComparable: 0,
  creativeTestsIncomplete: 0,
  crmAccess: "ready",
  unattributedLeads: 0,
  paidUnattributedDeals: 0,
};

test("guides the owner to a first disabled campaign", () => {
  const brief = assistant.buildAdvertisingAssistantBrief({ ...readyInput, createdLaunches: 0 });
  assert.equal(brief.reason, "first_campaign");
  assert.equal(brief.href, "/ads-automation");
  assert.match(brief.text, /выключенной/);
});

test("launch failure has priority over analytics and attribution", () => {
  const brief = assistant.buildAdvertisingAssistantBrief({
    ...readyInput,
    failedLaunches: 1,
    paidUnattributedDeals: 3,
  });
  assert.equal(brief.reason, "launch_failed");
  assert.equal(brief.href, "/ads-automation/history");
});

test("video processing asks the owner to wait instead of retrying", () => {
  const brief = assistant.buildAdvertisingAssistantBrief({ ...readyInput, processingLaunches: 2 });
  assert.equal(brief.reason, "video_processing");
  assert.match(brief.text, /Дождитесь/);
});

test("missing Insights leads to the protected manual sync area", () => {
  const brief = assistant.buildAdvertisingAssistantBrief({
    ...readyInput,
    campaignsWithInsights: 0,
    insightsNotSynced: 2,
  });
  assert.equal(brief.reason, "insights_not_synced");
  assert.equal(brief.href, "/admin");
});

test("a complete zero-row sync is explained as zero delivery", () => {
  const brief = assistant.buildAdvertisingAssistantBrief({
    ...readyInput,
    campaignsWithInsights: 0,
    insightsEmpty: 1,
  });
  assert.equal(brief.reason, "zero_delivery");
  assert.match(brief.text, /нормальное состояние/);
});

test("paid sales without attribution are prioritized over leads", () => {
  const brief = assistant.buildAdvertisingAssistantBrief({
    ...readyInput,
    campaignsWithInsights: 0,
    unattributedLeads: 4,
    paidUnattributedDeals: 1,
  });
  assert.equal(brief.reason, "link_paid_sales");
  assert.equal(brief.href, "/sales");
});

test("unattributed leads get one direct CRM action", () => {
  const brief = assistant.buildAdvertisingAssistantBrief({
    ...readyInput,
    campaignsWithInsights: 0,
    unattributedLeads: 4,
  });
  assert.equal(brief.reason, "link_leads");
  assert.equal(brief.href, "/leads");
});

test("an incomplete creative test asks for one comparable period", () => {
  const brief = assistant.buildAdvertisingAssistantBrief({
    ...readyInput,
    creativeTestsIncomplete: 2,
  });
  assert.equal(brief.reason, "creative_test_needs_same_period");
  assert.equal(brief.href, "/admin");
  assert.match(brief.text, /одинаковые даты/);
});

test("CRM attribution keeps priority over a comparable creative test", () => {
  const brief = assistant.buildAdvertisingAssistantBrief({
    ...readyInput,
    creativeTestsComparable: 1,
    unattributedLeads: 2,
  });
  assert.equal(brief.reason, "link_leads");
});

test("a comparable creative test exposes facts without choosing a winner", () => {
  const brief = assistant.buildAdvertisingAssistantBrief({
    ...readyInput,
    creativeTestsComparable: 1,
  });
  assert.equal(brief.reason, "creative_test_ready");
  assert.equal(brief.href, "/ads-automation/history");
  assert.match(brief.text, /не выбирает победителя/);
  assert.doesNotMatch(brief.text, /CPL|ROI|ROMI|лучший вариант/i);
});

test("verified facts produce an honest ready state", () => {
  const brief = assistant.buildAdvertisingAssistantBrief(readyInput);
  assert.equal(brief.reason, "results_ready");
  assert.match(brief.text, /нет автоматической оценки эффективности/);
});

test("every action stays inside read-only or disabled-first product routes", () => {
  const variants = [
    readyInput,
    { ...readyInput, createdLaunches: 0 },
    { ...readyInput, failedLaunches: 1 },
    { ...readyInput, processingLaunches: 1 },
    { ...readyInput, campaignsWithInsights: 0, insightsNotSynced: 1 },
    { ...readyInput, campaignsWithInsights: 0, paidUnattributedDeals: 1 },
    { ...readyInput, campaignsWithInsights: 0, unattributedLeads: 1 },
    { ...readyInput, creativeTestsIncomplete: 1 },
    { ...readyInput, creativeTestsComparable: 1 },
  ];
  const allowed = new Set(["/ads-automation", "/ads-automation/history", "/admin", "/leads", "/sales"]);
  for (const input of variants) {
    const brief = assistant.buildAdvertisingAssistantBrief(input);
    if (brief.href) assert.equal(allowed.has(brief.href), true);
  }
});
