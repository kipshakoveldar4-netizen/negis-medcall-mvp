import type { VercelRequest, VercelResponse } from "@vercel/node";

type Handler = (req: VercelRequest, res: VercelResponse) => unknown;
export function createOperatorPreviewHandler(
  loadCrm: () => Promise<Handler>,
  environment?: () => NodeJS.ProcessEnv,
  expectedProjectId?: string | null,
  expectedWorkspaceId?: string | null,
): (req: VercelRequest, res: VercelResponse) => Promise<unknown>;
