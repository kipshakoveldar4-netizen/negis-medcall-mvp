import { Router } from "express";
import nodemailer from "nodemailer";
import { supabaseAdmin } from "../lib/supabase-admin.js";
import { logger } from "../lib/logger.js";

const router = Router();

/* ── Helpers ────────────────────────────────────────── */
function generatePassword(length = 12): string {
  const upper  = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower  = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const all    = upper + lower + digits;
  let pwd = "";
  /* Guarantee at least one of each class */
  pwd += upper [Math.floor(Math.random() * upper.length)];
  pwd += lower [Math.floor(Math.random() * lower.length)];
  pwd += digits[Math.floor(Math.random() * digits.length)];
  for (let i = 3; i < length; i++) {
    pwd += all[Math.floor(Math.random() * all.length)];
  }
  /* Shuffle */
  return pwd.split("").sort(() => Math.random() - 0.5).join("");
}

function createTransport() {
  return nodemailer.createTransport({
    host: "smtp.zoho.com",
    port: 587,
    secure: false,
    auth: {
      user: "negissupport@negis.online",
      pass: process.env.ZOHO_SMTP_PASSWORD ?? "",
    },
    tls: { rejectUnauthorized: false },
  });
}

/* ── POST /api/auth/reset-password ──────────────────── */
router.post("/auth/reset-password", async (req, res) => {
  const { email } = req.body as { email?: string };

  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "Введите корректный email" });
    return;
  }

  /* 1. Find user by email */
  const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000, page: 1 });
  if (listErr) {
    logger.error({ err: listErr }, "listUsers failed");
    res.status(500).json({ error: "Ошибка сервера" });
    return;
  }

  const user = list.users.find(u => u.email?.toLowerCase() === email.toLowerCase());

  /* Always return success even if user not found — don't leak existence */
  if (!user) {
    res.json({ ok: true });
    return;
  }

  /* 2. Generate temp password & update */
  const tempPassword = generatePassword(12);
  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
    password: tempPassword,
  });

  if (updateErr) {
    logger.error({ err: updateErr }, "updateUserById failed");
    res.status(500).json({ error: "Ошибка сервера" });
    return;
  }

  /* 3. Send email */
  try {
    const transport = createTransport();
    await transport.sendMail({
      from: '"Negis Support" <negissupport@negis.online>',
      to: email,
      subject: "Временный пароль для входа в Negis",
      text: [
        "Здравствуйте!",
        "",
        "Вы запросили восстановление доступа к Negis.",
        "",
        `Ваш временный пароль: ${tempPassword}`,
        "",
        "Войдите на сайте: https://www.negis.online",
        "",
        "После входа рекомендуем изменить пароль в настройках.",
        "",
        "Если вы не запрашивали сброс пароля — обратитесь в поддержку.",
        "",
        "Negis Support",
      ].join("\n"),
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #F4F7FB; padding: 32px 16px;">
          <div style="background: #fff; border: 1px solid #E7ECF3; border-radius: 16px; padding: 32px 28px;">
            <div style="margin-bottom: 24px;">
              <span style="background: #DDE5EE; border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.18em; color: #0B1220; text-transform: uppercase;">NEGIS</span>
            </div>
            <h2 style="margin: 0 0 16px; font-size: 18px; color: #0B1220; font-weight: 700;">Временный пароль</h2>
            <p style="margin: 0 0 12px; font-size: 14px; color: #64748B; line-height: 1.6;">
              Вы запросили восстановление доступа. Используйте временный пароль для входа:
            </p>
            <div style="background: #F4F7FB; border: 1px solid #E7ECF3; border-radius: 10px; padding: 16px; text-align: center; margin: 20px 0;">
              <span style="font-size: 22px; font-weight: 700; color: #1E325C; letter-spacing: 0.08em; font-family: monospace;">${tempPassword}</span>
            </div>
            <p style="margin: 0 0 20px; font-size: 13px; color: #94A3B8; line-height: 1.5;">
              После входа рекомендуем изменить пароль.
            </p>
            <a href="https://www.negis.online" style="display: block; background: #1E325C; color: #fff; text-decoration: none; text-align: center; padding: 13px 20px; border-radius: 12px; font-size: 14px; font-weight: 600;">
              Войти в Negis
            </a>
            <p style="margin: 20px 0 0; font-size: 12px; color: #CBD5E1; text-align: center;">
              Если вы не запрашивали сброс — обратитесь в поддержку.
            </p>
          </div>
        </div>
      `,
    });
    logger.info({ userId: user.id }, "temp password email sent");
  } catch (mailErr) {
    logger.error({ err: mailErr }, "failed to send email");
    res.status(500).json({ error: "Не удалось отправить письмо. Проверьте настройки почты." });
    return;
  }

  res.json({ ok: true });
});

export default router;
