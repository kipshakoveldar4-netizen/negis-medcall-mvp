// Negis OS theme presets — metadata only (see docs/DESIGN-SYSTEM.md §14).
//
// This file intentionally has NO runtime behavior: no theme switching, no
// persistence, no DB fields. It documents the future preset catalog and the
// token values each preset would apply. Choosing a theme is purely visual and
// must never change permissions, client/admin visibility, Ads Automation
// safety, ACTIVE gating, Meta launch status, or the technical-details policy.

export type NegisThemeTokenKey =
  | "bg"
  | "surface"
  | "surfaceGlass"
  | "border"
  | "primary"
  | "primarySoft"
  | "secondary"
  | "ai"
  | "success"
  | "warning"
  | "error"
  | "text"
  | "muted"
  | "radiusCard"
  | "shadowCard";

export type NegisThemePreset = {
  id: string;
  name: string;
  description: string;
  targetClinicType: string;
  tokens: Partial<Record<NegisThemeTokenKey, string>>;
};

// The default preset shipped in the MVP. Its token values match the live
// `--negis-*` CSS variables in index.css.
export const defaultThemePresetId = "glass-ai";

export const negisThemePresets: NegisThemePreset[] = [
  {
    id: "medical-clean",
    name: "Medical Clean",
    description: "Спокойный white/mint/blue вид для классических клиник.",
    targetClinicType: "Классические клиники, стоматология, диагностика",
    tokens: {
      bg: "#F4F8FB",
      surface: "rgba(255,255,255,0.92)",
      surfaceGlass: "rgba(255,255,255,0.82)",
      border: "rgba(100,116,139,0.16)",
      primary: "#0D9488",
      primarySoft: "#E6F7F3",
      secondary: "#2563EB",
      ai: "#3B82F6",
      text: "#0F172A",
      muted: "#64748B",
      radiusCard: "20px",
      shadowCard: "0 8px 24px rgba(15,23,42,0.05)",
    },
  },
  {
    id: "glass-ai",
    name: "Glass AI",
    description: "Glass-поверхности, пастельные градиенты и AI-акценты. Тема по умолчанию (Glass Morphic Medical AI).",
    targetClinicType: "Премиум-клиники и современные медицинские сети",
    tokens: {
      bg: "#EEF4F8",
      surface: "rgba(255,255,255,0.78)",
      surfaceGlass: "rgba(255,255,255,0.55)",
      border: "rgba(100,116,139,0.18)",
      primary: "#0D9488",
      primarySoft: "#E6F7F3",
      secondary: "#2563EB",
      ai: "#7C3AED",
      success: "#10B981",
      warning: "#F59E0B",
      error: "#EF4444",
      text: "#0F172A",
      muted: "#64748B",
      radiusCard: "24px",
      shadowCard: "0 10px 30px rgba(15,23,42,0.06)",
    },
  },
  {
    id: "beauty-premium",
    name: "Beauty Premium",
    description: "Мягкий beige, blush и gold/pink акценты для beauty-сегмента.",
    targetClinicType: "Косметология, beauty, wellness",
    tokens: {
      bg: "#FBF5F2",
      surface: "rgba(255,255,255,0.82)",
      surfaceGlass: "rgba(255,251,248,0.62)",
      border: "rgba(190,150,130,0.20)",
      primary: "#C2896B",
      primarySoft: "#F6E7DE",
      secondary: "#D9A441",
      ai: "#B06A9E",
      text: "#3A2A24",
      muted: "#8A756B",
      radiusCard: "26px",
      shadowCard: "0 12px 30px rgba(120,80,60,0.08)",
    },
  },
  {
    id: "organic-care",
    name: "Organic Care",
    description: "Натуральный зелёный, cream и органичные формы.",
    targetClinicType: "Wellness, реабилитация, семейная медицина, нутрициология",
    tokens: {
      bg: "#F3F7F0",
      surface: "rgba(255,255,255,0.86)",
      surfaceGlass: "rgba(250,253,247,0.64)",
      border: "rgba(110,140,100,0.20)",
      primary: "#4E9E6A",
      primarySoft: "#E6F3E9",
      secondary: "#7BAE5A",
      ai: "#5DAE9B",
      text: "#26332A",
      muted: "#6B7A6E",
      radiusCard: "28px",
      shadowCard: "0 12px 30px rgba(60,90,60,0.08)",
    },
  },
  {
    id: "dark-pro",
    name: "Dark Pro",
    description: "Тёмный операционный дашборд с сильным контрастом.",
    targetClinicType: "Админ / разработчик / продвинутые пользователи",
    tokens: {
      bg: "#0B1220",
      surface: "rgba(20,30,48,0.92)",
      surfaceGlass: "rgba(30,41,59,0.72)",
      border: "rgba(148,163,184,0.22)",
      primary: "#2DD4BF",
      primarySoft: "rgba(45,212,191,0.14)",
      secondary: "#60A5FA",
      ai: "#A78BFA",
      text: "#E2E8F0",
      muted: "#94A3B8",
      radiusCard: "18px",
      shadowCard: "0 12px 30px rgba(0,0,0,0.40)",
    },
  },
  {
    id: "brand-custom",
    name: "Brand Custom",
    description: "Логотип клиники, свои цвета, брендированные отчёты и домен (позже). Значения токенов задаёт клиника.",
    targetClinicType: "Business / Managed / White-label",
    tokens: {},
  },
];

export function getThemePreset(id: string): NegisThemePreset | undefined {
  return negisThemePresets.find((preset) => preset.id === id);
}
