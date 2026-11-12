import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase-admin.js";

const router = Router();

/* ── List employees for a clinic ── */
router.get("/admin/employees", async (req, res) => {
  const { clinic_id } = req.query as { clinic_id?: string };
  if (!clinic_id) { res.status(400).json({ error: "clinic_id required" }); return; }

  const { data: agents, error } = await supabaseAdmin
    .from("agents")
    .select("id, name, email, hourly_rate, weekly_target, user_id, role_id")
    .eq("clinic_id", clinic_id)
    .order("created_at");

  if (error) { res.status(500).json({ error: error.message }); return; }

  const userIds = (agents ?? []).map((a) => a.user_id).filter(Boolean);
  let rolesMap: Record<string, string> = {};

  if (userIds.length > 0) {
    const { data: roleRows } = await supabaseAdmin
      .from("user_roles")
      .select("user_id, role")
      .in("user_id", userIds)
      .eq("clinic_id", clinic_id);
    rolesMap = Object.fromEntries((roleRows ?? []).map((r) => [r.user_id, r.role]));
  }

  const result = (agents ?? []).map((a) => ({
    ...a,
    user_roles: a.user_id ? [{ role: rolesMap[a.user_id] ?? "agent" }] : [],
  }));

  res.json(result);
});

/* ── Create employee ── */
router.post("/admin/employees", async (req, res) => {
  const { clinic_id, name, email, password, role, hourly_rate, weekly_target, role_id } = req.body as {
    clinic_id: string;
    name: string;
    email: string;
    password: string;
    role: string;
    hourly_rate?: number;
    weekly_target?: number;
    role_id?: string | null;
  };

  if (!clinic_id || !name || !email || !password || !role) {
    res.status(400).json({ error: "clinic_id, name, email, password, role are required" });
    return;
  }

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name },
  });

  if (authError) { res.status(400).json({ error: authError.message }); return; }
  const userId = authData.user.id;

  const { error: agentError } = await supabaseAdmin.from("agents").insert({
    clinic_id,
    user_id: userId,
    name,
    email,
    hourly_rate: hourly_rate ?? 0,
    weekly_target: weekly_target ?? 20,
    role_id: role_id ?? null,
  });

  if (agentError) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    res.status(500).json({ error: agentError.message });
    return;
  }

  const { error: roleError } = await supabaseAdmin.from("user_roles").insert({
    user_id: userId,
    clinic_id,
    role,
  });

  if (roleError) {
    req.log.warn({ roleError }, "Failed to insert user_role");
  }

  res.status(201).json({ success: true, user_id: userId });
});

/* ── Update employee (name, role, hourly_rate, weekly_target) ── */
router.patch("/admin/employees/:id", async (req, res) => {
  const { id } = req.params;
  const { name, role, hourly_rate, weekly_target, clinic_id, role_id } = req.body as {
    name?: string;
    role?: string;
    hourly_rate?: number;
    weekly_target?: number;
    clinic_id: string;
    role_id?: string | null;
  };

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (hourly_rate !== undefined) updates.hourly_rate = hourly_rate;
  if (weekly_target !== undefined) updates.weekly_target = weekly_target;
  if (role_id !== undefined) updates.role_id = role_id;

  if (Object.keys(updates).length > 0) {
    const { error } = await supabaseAdmin.from("agents").update(updates).eq("id", id);
    if (error) { res.status(500).json({ error: error.message }); return; }
  }

  if (role && clinic_id) {
    const { data: agent } = await supabaseAdmin
      .from("agents").select("user_id").eq("id", id).single();
    if (agent?.user_id) {
      await supabaseAdmin.from("user_roles")
        .upsert({ user_id: agent.user_id, clinic_id, role }, { onConflict: "user_id,clinic_id" });
    }
  }

  res.json({ success: true });
});

/* ── Delete employee ── */
router.delete("/admin/employees/:id", async (req, res) => {
  const { id } = req.params;

  const { data: agent } = await supabaseAdmin
    .from("agents").select("user_id").eq("id", id).single();

  const { error } = await supabaseAdmin.from("agents").delete().eq("id", id);
  if (error) { res.status(500).json({ error: error.message }); return; }

  if (agent?.user_id) {
    await supabaseAdmin.from("user_roles").delete().eq("user_id", agent.user_id);
    await supabaseAdmin.auth.admin.deleteUser(agent.user_id);
  }

  res.json({ success: true });
});

export default router;
