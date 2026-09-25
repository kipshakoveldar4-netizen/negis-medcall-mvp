import { VERTICAL_SETTINGS_KEY, type Vertical } from "../vertical/terms";

export type WorkspacePurpose = "clinic_services" | "marketing";
export const WORKSPACE_PURPOSE_SETTINGS_KEY = "workspace_purpose";

export function readOnboardingPurpose(value: unknown): WorkspacePurpose | null {
  if (value === undefined || value === "clinic_services") return "clinic_services";
  return value === "marketing" ? "marketing" : null;
}

/** Purpose is not an advertising compliance policy or a permission grant. */
export function onboardingSettings(
  workspaceId: string,
  input: { purpose: WorkspacePurpose; vertical: Vertical; timeZone: string },
) {
  return [
    input.purpose === "marketing"
      ? { workspace_id: workspaceId, key: WORKSPACE_PURPOSE_SETTINGS_KEY, value: { purpose: "marketing" } }
      : { workspace_id: workspaceId, key: VERTICAL_SETTINGS_KEY, value: { vertical: input.vertical } },
    { workspace_id: workspaceId, key: "clinic_schedule", value: { timeZone: input.timeZone } },
  ];
}
