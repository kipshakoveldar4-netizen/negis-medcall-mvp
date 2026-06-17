import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase-admin.js";

const router = Router();

/* ── POST /api/ads/tiktok/callback ──────────────────────────
   Server-side exchange of TikTok OAuth authorization code
   for an access token. Reads App ID + Secret from the
   platform_configs table (entered by the clinic admin).
─────────────────────────────────────────────────────────── */
router.post("/ads/tiktok/callback", async (req, res) => {
  const { code, clinic_id } = req.body as { code?: string; clinic_id?: string };

  if (!code || !clinic_id) {
    res.status(400).json({ error: "Необходимы параметры code и clinic_id" });
    return;
  }

  /* 1. Load TikTok app credentials for this clinic */
  const { data: cfg, error: cfgErr } = await supabaseAdmin
    .from("platform_configs")
    .select("app_id, app_secret")
    .eq("clinic_id", clinic_id)
    .eq("platform", "tiktok")
    .single();

  if (cfgErr || !cfg) {
    res.status(400).json({
      error:
        "TikTok App не настроен для этой клиники. Введите App ID и App Secret в разделе Настройки → Интеграции.",
    });
    return;
  }

  const { app_id, app_secret } = cfg as { app_id: string; app_secret: string };

  if (!app_id || !app_secret) {
    res.status(400).json({
      error: "App ID или App Secret не заполнены в настройках интеграции TikTok.",
    });
    return;
  }

  /* 2. Exchange code for access token */
  let tokenJson: any;
  try {
    const tokenRes = await fetch(
      "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id, secret: app_secret, auth_code: code }),
      },
    );
    tokenJson = await tokenRes.json();
  } catch (e: any) {
    req.log.error({ err: e }, "TikTok token fetch failed");
    res.status(502).json({ error: `Ошибка сети при запросе TikTok API: ${e.message}` });
    return;
  }

  if (tokenJson.code !== 0) {
    res.status(400).json({
      error: `TikTok вернул ошибку: ${tokenJson.message ?? tokenJson.code}`,
    });
    return;
  }

  const accessToken: string = tokenJson.data?.access_token ?? "";
  const advertiserIds: string[] = tokenJson.data?.advertiser_ids ?? [];
  const advertiserId = advertiserIds[0] ?? "";

  if (!accessToken || !advertiserId) {
    res.status(400).json({
      error: "TikTok не вернул access_token или advertiser_id.",
    });
    return;
  }

  /* 3. Fetch account name from TikTok */
  let accountName = advertiserId;
  try {
    const infoRes = await fetch(
      `https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/?` +
        `advertiser_ids=${encodeURIComponent(JSON.stringify([advertiserId]))}` +
        `&fields=${encodeURIComponent(JSON.stringify(["advertiser_id", "advertiser_name"]))}`,
      { headers: { "Access-Token": accessToken } },
    );
    const infoJson = await infoRes.json() as any;
    const list: any[] = infoJson.data?.list ?? [];
    if (list[0]?.advertiser_name) accountName = list[0].advertiser_name;
  } catch {
    /* fallback to advertiserId as name */
  }

  res.json({ access_token: accessToken, advertiser_id: advertiserId, account_name: accountName });
});

export default router;
