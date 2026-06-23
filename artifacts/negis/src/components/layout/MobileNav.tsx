import { useState } from "react";
import { useLocation } from "wouter";
import {
  BarChart2,
  BrainCircuit,
  CalendarDays,
  Clapperboard,
  ClipboardList,
  MessageCircle,
  Megaphone,
  Menu,
  PhoneCall,
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

const primaryItems: MobileNavItem[] = [
  { href: "/dashboard", label: "Дашборд", icon: BarChart2, permission: "dashboard" },
  { href: "/appointments", label: "Запись", icon: CalendarDays, permission: "booking" },
  { href: "/clients", label: "Клиенты", icon: Users, permission: "crm" },
  { href: "/leads", label: "Лиды", icon: ClipboardList, permission: "crm" },
];

const drawerItems: MobileNavItem[] = [
  { href: "/targeting-agent", label: "ИИ таргетолог", icon: BrainCircuit, permission: "ads" },
  { href: "/content-studio", label: "ИИ студия контента", icon: Clapperboard, permission: "ads" },
  { href: "/ads", label: "Реклама", icon: Megaphone, permission: "ads" },
  { href: "/reception", label: "Ресепшн", icon: User, permission: "reception" },
  { href: "/calls", label: "Звонки", icon: PhoneCall, permission: "reception" },
  { href: "/tasks", label: "Задачи", icon: ClipboardList, permission: "tasks" },
  { href: "/chat", label: "Чат", icon: MessageCircle, permission: "chat" },
  { href: "/market", label: "Маркет", icon: Store, permission: "marketplace" },
  { href: "/reports", label: "Отчёты", icon: BarChart2, permission: "ads" },
  { href: "/admin", label: "Админ", icon: Settings, permission: "admin" },
  { href: "/profile", label: "Профиль", icon: User, permission: "dashboard" },
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
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#64748B]">Меню</p>
                <h2 className="mt-1 text-lg font-black text-[#0F172A]">Разделы Negis</h2>
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
