import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase-admin.js";
import { logger } from "../lib/logger.js";

const router = Router();

type RegisterInput = {
  ownerName: string;
  workspaceName: string;
  email: string;
  password: string;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

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

function parseInput(body: unknown): { input?: RegisterInput; details: string[] } {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const ownerName =
    readString(record.ownerName) ||
    readString(record.name) ||
    readString(record.fullName);
  const workspaceName =
    readString(record.workspaceName) ||
    readString(record.clinicName) ||
    readString(record.companyName);
  const email = readString(record.email);
  const password = readString(record.password);
  const details: string[] = [];

  if (!ownerName) details.push("name is required");
  if (!workspaceName) details.push("workspaceName is required");
  if (!email) details.push("email is required");
  if (!password) details.push("password is required");
  if (email && !email.includes("@")) details.push("email must be valid");
  if (password && password.length < 8) details.push("password must be at least 8 characters");

  if (details.length > 0) return { details };
  return { input: { ownerName, workspaceName, email, password }, details };
}

function successBody(input: RegisterInput, workspaceId: string, mode: "demo" | "supabase") {
  return {
    success: true,
    mode,
    data: {
      workspaceId,
      workspaceName: input.workspaceName,
      user: {
        name: input.ownerName,
        email: input.email,
      },
      redirectTo: "/dashboard",
    },
  };
}

function errorBody(error: string, details: string[] = []) {
  return {
    success: false,
    error,
    details,
  };
}

router.post("/auth/register", async (req, res) => {
  const { input, details } = parseInput(req.body);
  if (!input) {
    res.status(400).json(errorBody("Validation error", details));
    return;
  }

  if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(201).json(successBody(input, "demo-workspace", "demo"));
    return;
  }

  let userId: string | null = null;
  let clinicId: string | null = null;

  try {
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email: input.email,
        password: input.password,
        email_confirm: true,
        user_metadata: { full_name: input.ownerName },
      });

    if (authError || !authData.user?.id) {
      res
        .status(400)
        .json(errorBody("Registration failed", [authError?.message ?? "Failed to create user"]));
      return;
    }

    userId = authData.user.id;

    const { data: clinic, error: clinicError } = await supabaseAdmin
      .from("clinics")
      .insert({
        name: input.workspaceName,
        owner_id: userId,
        slug: slugifyClinicName(input.workspaceName),
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

    res.status(201).json(successBody(input, clinicId, "supabase"));
  } catch (err) {
    logger.error({ err }, "register failed");

    if (clinicId) {
      await supabaseAdmin.from("user_roles").delete().eq("clinic_id", clinicId);
      await supabaseAdmin.from("clinics").delete().eq("id", clinicId);
    }

    if (userId) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
    }

    res
      .status(500)
      .json(errorBody("Registration failed", [err instanceof Error ? err.message : "Registration failed"]));
  }
});

export default router;
