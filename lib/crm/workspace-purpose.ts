import { isVertical, VERTICAL_SETTINGS_KEY, type Vertical } from "../vertical/terms";

export type WorkspacePurpose = "clinic_services" | "marketing" | "mortgage_leads";
export const WORKSPACE_PURPOSE_SETTINGS_KEY = "workspace_purpose";

export function isWorkspacePurpose(value: unknown): value is WorkspacePurpose {
  return value === "clinic_services" || value === "marketing" || value === "mortgage_leads";
}

export function readOnboardingPurpose(value: unknown): WorkspacePurpose | null {
  if (value === undefined || value === "clinic_services") return "clinic_services";
  return isWorkspacePurpose(value) ? value : null;
}

/** Purpose is not an advertising compliance policy or a permission grant. */
export function onboardingSettings(
  workspaceId: string,
  input: { purpose: WorkspacePurpose; vertical: Vertical | null; timeZone: string },
) {
  if (input.purpose === "clinic_services" && !isVertical(input.vertical)) {
    throw new Error("workspace_vertical_required");
  }
  return [
    input.purpose === "clinic_services"
      ? { workspace_id: workspaceId, key: VERTICAL_SETTINGS_KEY, value: { vertical: input.vertical } }
      : { workspace_id: workspaceId, key: WORKSPACE_PURPOSE_SETTINGS_KEY, value: { purpose: input.purpose } },
    { workspace_id: workspaceId, key: "clinic_schedule", value: { timeZone: input.timeZone } },
  ];
}
