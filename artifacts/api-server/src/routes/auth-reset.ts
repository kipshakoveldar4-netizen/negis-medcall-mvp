import { Router } from "express";

const router = Router();

// Retired: password recovery must confirm ownership through Supabase Auth.
router.post("/auth/reset-password", (_req, res) => {
  res.status(410).json({ code: "password_reset_disabled" });
});

export default router;
