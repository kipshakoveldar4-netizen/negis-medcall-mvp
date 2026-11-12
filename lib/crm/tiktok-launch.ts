import type { VercelRequest, VercelResponse } from "@vercel/node";
import { TikTokCampaignValidationError } from "../tiktok/campaign";
import { TikTokConnectionError } from "../tiktok/connections";
import {
  launchTikTokCampaignDisabled,
  TikTokLaunchError,
} from "../tiktok/launch";
import { readWorkspaceContext } from "./server";

export async function handleTikTokLaunch(
  req: VercelRequest,
  res: VercelResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
      details: ["Use POST"],
    });
  }

  const context = readWorkspaceContext(req);
  if (!context) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
      details: [],
    });
  }

  try {
    const data = await launchTikTokCampaignDisabled(
      context.workspaceId,
      context.staffUserId,
      req.body,
    );
    return res.status(200).json({ success: true, mode: "supabase", data });
  } catch (error) {
    if (error instanceof TikTokCampaignValidationError) {
      return res.status(400).json({
        success: false,
        error: "Validation error",
        code: "invalid_request",
        details: error.issues.map((issue) => issue.message),
      });
    }
    const safe =
      error instanceof TikTokLaunchError ||
      error instanceof TikTokConnectionError
        ? error
        : new TikTokLaunchError(
            503,
            "persistence_failed",
            "Не удалось безопасно завершить запуск. Повтор не выполняется автоматически.",
            "persistence",
            true,
          );
    return res.status(safe.status).json({
      success: false,
      error: safe.message,
      code: safe.code,
      details: [],
    });
  }
}
