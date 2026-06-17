import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase-admin.js";

const router = Router();

/**
 * POST /api/impersonation/session
 *
 * Verifies an impersonation token with Negis Control, then generates a
 * short-lived Supabase magic-link token for the clinic owner so the
 * frontend can establish a real Supabase session (required for RLS).
 *
 * Body: { impersonateToken: string; ownerEmail: string }
 * Response: { tokenHash: string }
 */
router.post("/impersonation/session", async (req, res) => {
  const { impersonateToken, ownerEmail } = req.body as {
    impersonateToken?: string;
    ownerEmail?: string;
  };

  if (!impersonateToken || !ownerEmail) {
    res.status(400).json({ error: "impersonateToken and ownerEmail required" });
    return;
  }

  /* 1. Re-verify the token with Negis Control (double-check, server-side) */
  const controlApiUrl =
    process.env.VITE_NEGIS_CONTROL_API_URL ?? "https://admin.negis.online";

  let verifyData: { clinicId: string; ownerEmail: string } | null = null;
  try {
    const verifyRes = await fetch(
      `${controlApiUrl}/api/impersonation/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: impersonateToken }),
      },
    );
    if (!verifyRes.ok) {
      res.status(401).json({ error: "Token invalid or expired" });
      return;
    }
    verifyData = (await verifyRes.json()) as { clinicId: string; ownerEmail: string };
  } catch {
    res.status(502).json({ error: "Could not reach Negis Control" });
    return;
  }

  /* 2. Sanity-check that the email matches what the frontend sent */
  if (verifyData?.ownerEmail !== ownerEmail) {
    res.status(401).json({ error: "Email mismatch" });
    return;
  }

  /* 3. Generate a Supabase magic-link for the clinic owner.
        The hashed_token can be exchanged by the frontend via verifyOtp. */
  const { data: linkData, error: linkError } =
    await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: ownerEmail,
      options: { redirectTo: "https://www.negis.online/" },
    });

  if (linkError || !linkData?.properties?.hashed_token) {
    res.status(500).json({
      error: linkError?.message ?? "Failed to generate session token",
    });
    return;
  }

  res.json({ tokenHash: linkData.properties.hashed_token });
});

export default router;
