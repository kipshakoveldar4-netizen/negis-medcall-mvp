import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase-admin.js";
import { logger } from "../lib/logger.js";

const router = Router();

function slugifyClinicName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base || "clinic"}-${suffix}`;
}

router.post("/auth/register", async (req, res) => {
  const { ownerName, clinicName, email, password } = req.body as {
    ownerName?: string;
    clinicName?: string;
    email?: string;
    password?: string;
  };

  if (!ownerName || !clinicName || !email || !password) {
    res.status(400).json({ error: "ownerName, clinicName, email and password are required" });
    return;
  }

  if (!email.includes("@") || password.length < 8) {
    res.status(400).json({ error: "Invalid email or password" });
    return;
  }

  let userId: string | null = null;
  let clinicId: string | null = null;

  try {
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: ownerName },
      });

    if (authError || !authData.user?.id) {
      res.status(400).json({ error: authError?.message ?? "Failed to create user" });
      return;
    }

    userId = authData.user.id;

    const { data: clinic, error: clinicError } = await supabaseAdmin
      .from("clinics")
      .insert({
        name: clinicName,
        owner_id: userId,
        slug: slugifyClinicName(clinicName),
      })
      .select("id")
      .single();

    if (clinicError || !clinic?.id) {
      throw clinicError ?? new Error("Failed to create clinic");
    }

    clinicId = clinic.id as string;

    const { error: roleError } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: userId, clinic_id: clinicId, role: "owner" });

    if (roleError) {
      throw roleError;
    }

    res.status(201).json({ ok: true, userId, clinicId });
  } catch (err) {
    logger.error({ err }, "register failed");

    if (clinicId) {
      await supabaseAdmin.from("user_roles").delete().eq("clinic_id", clinicId);
      await supabaseAdmin.from("clinics").delete().eq("id", clinicId);
    }

    if (userId) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
    }

    res.status(500).json({ error: err instanceof Error ? err.message : "Registration failed" });
  }
});

export default router;
