import { useState } from "react";
import { useLocation } from "wouter";
import {
  BadgeDollarSign,
  BarChart2,
  CalendarDays,
  Clapperboard,
  ClipboardList,
  LayoutDashboard,
  MessageCircle,
  Megaphone,
  Menu,
  PhoneCall,
  Rocket,
  Settings,
  Store,
  User,
  Users,
  X,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

type MobileNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  permission: string;
};

// Medina OS mobile IA: the four highest-frequency operational routes + "Ещё".
const primaryItems: MobileNavItem[] = [
  { href: "/leads", label: "Заявки", icon: ClipboardList, permission: "crm" },
  { href: "/appointments", label: "Записи", icon: CalendarDays, permission: "booking" },
  { href: "/clients", label: "Клиенты", icon: Users, permission: "crm" },
  { href: "/sales", label: "Продажи", icon: BadgeDollarSign, permission: "crm" },
];

// Commercial-1: the customer drawer lists only working modules. Demo-only
// fixtures (Ресепшн, Звонки, Задачи, Чат, Маркет, Отчёты) are reachable by
// direct URL in demo mode but are not advertised in the sellable navigation.
const drawerItems: MobileNavItem[] = [
  { href: "/ai-control-center", label: "Главная", icon: LayoutDashboard, permission: "dashboard" },
  { href: "/dashboard", label: "Аналитика", icon: BarChart2, permission: "dashboard" },
  { href: "/ads-automation", label: "Реклама", icon: Rocket, permission: "ads" },
  { href: "/ads-automation/history", label: "История запусков", icon: Megaphone, permission: "ads" },
  { href: "/content-studio", label: "Контент", icon: Clapperboard, permission: "ads" },
  { href: "/admin", label: "Настройки клиники", icon: Settings, permission: "admin" },
];

function isActive(location: string, href: string) {
  return location === href || location.startsWith(`${href}/`) || (href === "/appointments" && location === "/booking");
}

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useLocation();
  const { signOut, userRole, rolePermissions } = useAuth();

  const canUse = (item: MobileNavItem) =>
    userRole === "owner" || userRole === "manager" || userRole === "admin" || Boolean(rolePermissions[item.permission]);
  const visiblePrimary = primaryItems.filter(canUse);
  const visibleDrawer = drawerItems.filter(canUse);
  const moreActive = visibleDrawer.some((item) => isActive(location, item.href));

  return (
    <>
      {open && (
        <div className="mobile-nav-backdrop md:hidden" onClick={() => setOpen(false)}>
          <section className="mobile-nav-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--ng-muted)" }}>Меню</p>
                <h2 className="mt-1 text-lg font-semibold" style={{ color: "var(--ng-text)" }}>Разделы Medina OS</h2>
              </div>
              <button type="button" className="neu-icon-btn" onClick={() => setOpen(false)} aria-label="Закрыть меню">
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {visibleDrawer.map(({ href, label, icon: Icon }) => (
                <button
                  key={href}
                  type="button"
                  className="mobile-nav-drawer-item"
                  onClick={() => {
                    setOpen(false);
                    setLocation(href);
                  }}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            <button
              type="button"
              className="mobile-nav-logout"
              onClick={() => {
                setOpen(false);
                void signOut();
              }}
            >
              <LogOut size={18} />
              Выйти
            </button>
          </section>
        </div>
      )}

      <nav className="mobile-bottom-nav md:hidden" aria-label="Основная мобильная навигация">
        {visiblePrimary.map(({ href, label, icon: Icon }) => {
          const active = isActive(location, href);
          return (
            <button
              key={href}
              type="button"
              className={`mobile-bottom-nav-item ${active ? "is-active" : ""}`}
              onClick={() => setLocation(href)}
            >
              <Icon size={20} />
              <span>{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`mobile-bottom-nav-item ${open || moreActive ? "is-active" : ""}`}
          onClick={() => setOpen(true)}
        >
          <Menu size={20} />
          <span>Ещё</span>
        </button>
      </nav>
    </>
  );
}
