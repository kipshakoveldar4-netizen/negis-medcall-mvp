import type { VercelRequest, VercelResponse } from "@vercel/node";
import { TikTokConnectionError } from "../tiktok/connections";
import { tikTokVideos } from "../tiktok/videoAssets";
import { readWorkspaceContext } from "./server";

export async function handleTikTokVideos(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  const context = readWorkspaceContext(req);
  if (!context) return res.status(401).json({ success: false, error: "Unauthorized", details: [] });
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  const value = req.method === "GET" ? req.query.assetId : body.assetId;
  const assetId = typeof value === "string" ? value.trim() : "";
  try {
    if (req.method === "GET") {
      const data = assetId ? await tikTokVideos.read(context.workspaceId, assetId) : await tikTokVideos.list(context.workspaceId);
      return res.status(200).json({ success: true, mode: "supabase", data });
    }
    if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed", details: ["Use GET or POST"] });
    if (body.confirm !== true) return res.status(400).json({ success: false, error: "Подтвердите передачу выбранного видео в TikTok.", details: [] });
    const data = await tikTokVideos.transfer(context.workspaceId, assetId, body.retry === true);
    return res.status(200).json({ success: true, mode: "supabase", data });
  } catch (error) {
    const safe = error instanceof TikTokConnectionError ? error : new TikTokConnectionError(503, "video_unavailable", "Не удалось проверить передачу видео. Обновите статус перед повторной попыткой.");
    return res.status(safe.status).json({ success: false, error: safe.message, code: safe.code, details: [] });
  }
}
