export type ControlPreviewTarget = { apiOrigin: string; supabaseUrl: string };
export function resolveControlPreviewTarget(
  env: Record<string, string | undefined>,
): ControlPreviewTarget | null;
