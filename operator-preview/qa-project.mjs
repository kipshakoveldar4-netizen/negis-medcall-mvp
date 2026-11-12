export const qaProjectName = "medina-os-qa";
export const qaAccountId = "team_jH6R9Mn1Dj6JF2AHOLgVbmLJ";
// This is the dedicated, empty QA project verified in Vercel.  The generic
// isDedicatedQaProjectId helper remains intentionally broader for staging
// tests, while runtime profiles use this exact pin by default.
export const qaProjectId = "prj_hb0CosZq4NuBKyTRA2dTiH9Enflb";

const sharedProjectId = "prj_CamDc1FHcejoVViq5wjq7BbNiyci";

export function isDedicatedQaProjectId(value) {
  return typeof value === "string" && /^prj_[A-Za-z0-9]+$/.test(value) && value !== sharedProjectId;
}
