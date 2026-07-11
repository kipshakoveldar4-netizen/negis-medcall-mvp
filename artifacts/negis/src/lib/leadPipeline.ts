export type LeadSemanticGroup = "new" | "in_progress" | "booked" | "lost";

export type LeadStageDefinition = {
  id: string;
  stageKey: string;
  name: string;
  color: string;
  semanticGroup: LeadSemanticGroup;
  sortOrder: number;
  isDefault: boolean;
  isActive: boolean;
};

export type LeadSourceDefinition = {
  id: string;
  sourceKey: string;
  name: string;
  channel: string;
  color: string;
  sortOrder: number;
  isDefault: boolean;
  isActive: boolean;
};

export const FALLBACK_LEAD_STAGES: LeadStageDefinition[] = [
  { id: "fallback:new", stageKey: "new", name: "Новая", color: "#2563eb", semanticGroup: "new", sortOrder: 10, isDefault: true, isActive: true },
  { id: "fallback:in_progress", stageKey: "in_progress", name: "В работе", color: "#d97706", semanticGroup: "in_progress", sortOrder: 20, isDefault: true, isActive: true },
  { id: "fallback:booked", stageKey: "booked", name: "Записана", color: "#059669", semanticGroup: "booked", sortOrder: 30, isDefault: true, isActive: true },
  { id: "fallback:lost", stageKey: "lost", name: "Потеряна", color: "#dc2626", semanticGroup: "lost", sortOrder: 40, isDefault: true, isActive: true },
];

export const FALLBACK_LEAD_SOURCES: LeadSourceDefinition[] = [
  { id: "fallback:manual", sourceKey: "manual", name: "Вручную", channel: "manual", color: "#64748b", sortOrder: 10, isDefault: true, isActive: true },
  { id: "fallback:meta_ads", sourceKey: "meta_ads", name: "Meta Ads", channel: "ads", color: "#2563eb", sortOrder: 20, isDefault: true, isActive: true },
  { id: "fallback:instagram", sourceKey: "instagram", name: "Instagram", channel: "social", color: "#db2777", sortOrder: 30, isDefault: true, isActive: true },
  { id: "fallback:whatsapp", sourceKey: "whatsapp", name: "WhatsApp", channel: "messenger", color: "#059669", sortOrder: 40, isDefault: true, isActive: true },
  { id: "fallback:website", sourceKey: "website", name: "Сайт", channel: "website", color: "#0891b2", sortOrder: 50, isDefault: true, isActive: true },
  { id: "fallback:referral", sourceKey: "referral", name: "Рекомендация", channel: "referral", color: "#7c3aed", sortOrder: 60, isDefault: true, isActive: true },
  { id: "fallback:webhook", sourceKey: "webhook", name: "Webhook", channel: "integration", color: "#475569", sortOrder: 70, isDefault: true, isActive: true },
  { id: "fallback:other", sourceKey: "other", name: "Другое", channel: "other", color: "#78716c", sortOrder: 80, isDefault: true, isActive: true },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function numberValue(value: unknown, fallback = 0): number {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  return value == null ? fallback : Boolean(value);
}

export function isLeadSemanticGroup(value: unknown): value is LeadSemanticGroup {
  return value === "new" || value === "in_progress" || value === "booked" || value === "lost";
}

export function normalizeLegacyLeadStatus(raw?: string): LeadSemanticGroup {
  const value = (raw || "").toLowerCase();
  if (/(work|в работе|обработ|прогресс|progress|contact|связ|звон)/.test(value)) return "in_progress";
  if (/(book|запис|schedul|приш[её]л|приш|arriv|visit|came|показ|appointment)/.test(value)) return "booked";
  if (/(lost|потер|отказ|reject|declin|cancel|отмен|fail|неудач|спам)/.test(value)) return "lost";
  return "new";
}

export function semanticGroupForLead(value: unknown): LeadSemanticGroup {
  const lead = asRecord(value);
  const stage = asRecord(lead.stage ?? lead.stageDefinition ?? lead.stage_definition);
  const structured = stringValue(lead.semanticGroup, lead.semantic_group, stage.semanticGroup, stage.semantic_group);
  if (isLeadSemanticGroup(structured)) return structured;
  return normalizeLegacyLeadStatus(stringValue(lead.status));
}

export function leadStageDefinitionFromUnknown(value: unknown): LeadStageDefinition | null {
  const record = asRecord(value);
  const id = stringValue(record.id);
  const stageKey = stringValue(record.stageKey, record.stage_key);
  const name = stringValue(record.name);
  const semanticGroup = stringValue(record.semanticGroup, record.semantic_group);
  if (!id || !stageKey || !name || !isLeadSemanticGroup(semanticGroup)) return null;

  return {
    id,
    stageKey,
    name,
    color: stringValue(record.color),
    semanticGroup,
    sortOrder: numberValue(record.sortOrder ?? record.sort_order),
    isDefault: booleanValue(record.isDefault ?? record.is_default, false),
    isActive: booleanValue(record.isActive ?? record.is_active, true),
  };
}

export function leadSourceDefinitionFromUnknown(value: unknown): LeadSourceDefinition | null {
  const record = asRecord(value);
  const id = stringValue(record.id);
  const sourceKey = stringValue(record.sourceKey, record.source_key);
  const name = stringValue(record.name);
  if (!id || !sourceKey || !name) return null;

  return {
    id,
    sourceKey,
    name,
    channel: stringValue(record.channel),
    color: stringValue(record.color),
    sortOrder: numberValue(record.sortOrder ?? record.sort_order),
    isDefault: booleanValue(record.isDefault ?? record.is_default, false),
    isActive: booleanValue(record.isActive ?? record.is_active, true),
  };
}
