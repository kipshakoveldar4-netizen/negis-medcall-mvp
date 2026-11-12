import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../lib/supabase-admin.js";

const router = Router();

/**
 * POST /api/test/login  — DEV ONLY (returns 404 in production)
 *
 * Generates a magic-link server-side, exchanges it for a real Supabase session,
 * and returns access/refresh tokens. The E2E test agent navigates to:
 *   /?dev_access_token=ACCESS&dev_refresh_token=REFRESH
 * and AuthContext calls supabase.auth.setSession() to establish a proper SDK session.
 *
 * Body:     { email: string }
 * Response: { accessToken: string; refreshToken: string }
 */
router.post("/test/login", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // Available in all environments — protected by needing a valid Supabase email


  const { email } = req.body as { email?: string };
  if (!email) {
    res.status(400).json({ error: "email required" });
    return;
  }

  const supabaseUrl     = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({ error: "Supabase env vars not configured" });
    return;
  }

  // Step 1: generate a magic-link token using the service-role admin client
  const { data: linkData, error: linkError } =
    await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });

  if (linkError || !linkData?.properties?.hashed_token) {
    res.status(500).json({ error: linkError?.message ?? "generateLink failed" });
    return;
  }

  // Step 2: exchange the token hash for a real session server-side
  const anonClient = createClient(supabaseUrl, supabaseAnonKey);
  const { data: otpData, error: otpError } =
    await anonClient.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "email",
    });

  if (otpError || !otpData?.session) {
    res.status(500).json({ error: otpError?.message ?? "verifyOtp failed" });
    return;
  }

  res.json({
    accessToken:  otpData.session.access_token,
    refreshToken: otpData.session.refresh_token,
  });
});

export default router;
