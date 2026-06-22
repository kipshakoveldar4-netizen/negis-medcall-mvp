import { useState } from "react";
import { Link, useLocation } from "wouter";
import { KeyRound, LogIn, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { apiUrl } from "@/lib/api";
import { hasSupabaseFrontendEnv, supabase } from "@/lib/supabase";
import { isStaffRole, roleLabels } from "@/lib/permissions";

type StaffUser = {
  id?: string;
  name?: string;
  email?: string;
  role?: string;
  status?: string;
  workspaceId?: string;
  workspace_id?: string;
};

async function safeJson(response: globalThis.Response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as {
      success?: boolean;
      data?: Record<string, unknown>;
      error?: string;
      details?: string[];
    };
  } catch {
    return null;
  }
}

function firstStaffUser(value: unknown): StaffUser | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const items = Array.isArray(record.staff)
    ? record.staff
    : Array.isArray(record.items)
      ? record.items
      : [];
  const staff = items[0];
  if (!staff || typeof staff !== "object" || Array.isArray(staff)) return null;
  return staff as StaffUser;
}

function saveStaffSession(staff: StaffUser, email: string, supabaseUserId?: string) {
  const workspaceId = staff.workspaceId || staff.workspace_id || "demo-workspace";
  const normalized = {
    id: staff.id || supabaseUserId || "demo-staff-user",
    name: staff.name || email,
    email,
    role: isStaffRole(staff.role) ? staff.role : "admin",
    status: staff.status || "active",
    workspaceId,
  };

  localStorage.setItem("negis_staff_user", JSON.stringify(normalized));
  localStorage.setItem(
    "negis_staff_session",
    JSON.stringify({
      mode: "staff",
      authenticated: true,
      createdAt: new Date().toISOString(),
      email,
      workspaceId,
      supabaseUserId,
    }),
  );
}

export default function Login() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) {
      toast.error("Введите email и пароль");
      return;
    }

    setLoading(true);
    try {
      if (!hasSupabaseFrontendEnv) {
        saveStaffSession(
          {
            id: "demo-staff-user",
            name: normalizedEmail,
            email: normalizedEmail,
            role: "admin",
            status: "active",
            workspaceId: "demo-workspace",
          },
          normalizedEmail,
        );
        toast.success("Demo-вход сотрудника выполнен");
        setLocation("/dashboard");
        return;
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

      if (error) {
        throw new Error(error.message);
      }

      const response = await fetch(apiUrl(`/api/crm/staff?email=${encodeURIComponent(normalizedEmail)}`));
      const body = await safeJson(response);
      const staff = body?.success === true ? firstStaffUser(body.data) : null;

      if (!response.ok || !staff) {
        await supabase.auth.signOut();
        throw new Error("Сотрудник не найден в staff_users. Проверьте, что администратор создал профиль.");
      }

      saveStaffSession(staff, normalizedEmail, data.user?.id);
      const role = isStaffRole(staff.role) ? roleLabels[staff.role] : "сотрудник";
      toast.success(`Вход выполнен: ${role}`);
      setLocation("/dashboard");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось войти");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main
      className="min-h-screen px-5 py-10"
      style={{
        background:
          "radial-gradient(circle at 16% 0%, rgba(13,148,136,0.10), transparent 30%), radial-gradient(circle at 86% 4%, rgba(15,118,110,0.08), transparent 28%), #EEF4F8",
      }}
    >
      <div className="mx-auto flex min-h-[calc(100vh-80px)] max-w-5xl items-center justify-center">
        <section className="grid w-full overflow-hidden rounded-[28px] border border-white/70 bg-white/70 shadow-[18px_24px_70px_rgba(88,104,124,0.18)] backdrop-blur-xl lg:grid-cols-[1fr_420px]">
          <div className="hidden p-10 lg:block">
            <div className="flex h-full flex-col justify-between rounded-[24px] bg-[#0F172A] p-8 text-white">
              <div>
                <div className="mb-8 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em]">
                  <ShieldCheck size={14} />
                  Staff access
                </div>
                <h1 className="max-w-md text-4xl font-black leading-tight">Negis CRM для сотрудников клиники</h1>
                <p className="mt-4 max-w-md text-sm leading-6 text-white/70">
                  Войдите по email и временному паролю, который выдал администратор. После входа откроется рабочий dashboard.
                </p>
              </div>
              <p className="text-xs text-white/50">Если Supabase frontend env не настроены, страница работает в demo fallback.</p>
            </div>
          </div>

          <div className="p-7 sm:p-10">
            <div className="mb-8">
              <Link href="/">
                <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#64748B]">NEGIS</span>
              </Link>
              <h2 className="mt-5 text-2xl font-black text-[#0F172A]">Вход сотрудника</h2>
              <p className="mt-2 text-sm leading-6 text-[#64748B]">
                Используйте email и временный пароль из карточки, которую показал администратор.
              </p>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Email</span>
                <input
                  className="neu-input w-full"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="employee@clinic.kz"
                  autoComplete="email"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Пароль</span>
                <input
                  className="neu-input w-full"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Временный пароль"
                  autoComplete="current-password"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit();
                  }}
                />
              </label>

              <button type="button" className="neu-btn-primary w-full justify-center py-3" onClick={submit} disabled={loading}>
                <LogIn size={17} />
                {loading ? "Проверяем..." : "Войти"}
              </button>

              <div className="rounded-2xl bg-[#F8FAFC] p-4 text-sm leading-6 text-[#64748B]">
                <div className="mb-1 flex items-center gap-2 font-bold text-[#0F172A]">
                  <KeyRound size={15} />
                  Временный пароль
                </div>
                После первого production-входа администратор может сбросить пароль в Supabase Auth. Сейчас MVP хранит только флаги, сам пароль в базе не сохраняется.
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
