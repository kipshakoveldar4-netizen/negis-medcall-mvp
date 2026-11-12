import { Router } from "express";

const router = Router();

// Retired until a signed-in, tenant-scoped OAuth flow with one-time state exists.
router.post("/ads/tiktok/callback", (_req, res) => {
  res.status(410).json({ error: "TikTok OAuth callback is unavailable", code: "oauth_disabled" });
});

export default router;
