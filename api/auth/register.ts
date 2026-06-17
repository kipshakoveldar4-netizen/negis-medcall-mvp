import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

type RegisterInput = {
  ownerName: string;
  workspaceName: string;
  email: string;
  password: string;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function slugifyWorkspaceName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base || "workspace"}-${suffix}`;
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

function demoSuccess(input: RegisterInput) {
  return {
    success: true,
    mode: "demo",
    data: {
      workspaceId: "demo-workspace",
      workspaceName: input.workspaceName,
      user: {
        name: input.ownerName,
        email: input.email,
      },
      redirectTo: "/targeting-agent",
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json(errorBody("Method not allowed"));
  }

  const { input, details } = parseInput(req.body);
  if (!input) {
    return res.status(400).json(errorBody("Validation error", details));
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(201).json(demoSuccess(input));
  }

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: authData, error: authError } =
      await supabase.auth.signUp({
        email: input.email,
        password: input.password,
        options: {
          data: { full_name: input.ownerName },
        },
      });

    if (authError || !authData.user?.id) {
      return res
        .status(400)
        .json(errorBody("Registration failed", [authError?.message ?? "Failed to create user"]));
    }

    const userId = authData.user.id;

    const { data: clinic, error: clinicError } = await supabase
      .from("clinics")
      .insert({
        name: input.workspaceName,
        owner_id: userId,
        slug: slugifyWorkspaceName(input.workspaceName),
      })
      .select("id")
      .single();

    if (clinicError || !clinic?.id) {
      throw clinicError ?? new Error("Failed to create workspace");
    }

    const workspaceId = clinic.id as string;

    const { error: roleError } = await supabase
      .from("user_roles")
      .insert({ user_id: userId, clinic_id: workspaceId, role: "owner" });

    if (roleError) throw roleError;

    return res.status(201).json({
      success: true,
      mode: "supabase",
      data: {
        workspaceId,
        workspaceName: input.workspaceName,
        user: {
          name: input.ownerName,
          email: input.email,
        },
        redirectTo: "/targeting-agent",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Registration failed";
    return res.status(500).json(errorBody("Registration failed", [message]));
  }
}
