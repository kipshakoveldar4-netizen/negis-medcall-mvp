import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import {
  BadgeDollarSign,
  BarChart2,
  CalendarDays,
  Clapperboard,
  FileText,
  ClipboardList,
  LayoutDashboard,
  MessageCircle,
  Megaphone,
  Menu,
  PhoneCall,
  Rocket,
  Settings,
  Store,
  Tag,
  User,
  Users,
  X,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { hasSupabaseFrontendEnv, supabase, sessionAuth } from "@/lib/supabase";
import { workspaceAllowsRoute } from "@/lib/workspaceRoutes";
import { capitalize, termsFor } from "../../../../../lib/vertical/terms";
import { ProfileDialog } from "./ProfileDialog";

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

// Commercial-1: the customer drawer lists only working modules. The remaining
// fixture screens (Ресепшн, Звонки, Задачи, Чат, Отчёты) are reachable by
// direct URL but are not advertised in the sellable navigation.
//
// «Маркет» из этого списка исключений вышел: он больше не фикстура с
// выдуманными числами, а каталог того, что клиника действительно может
// подключить, — поэтому он в ящике ниже, как обычный рабочий экран.
const drawerItems: MobileNavItem[] = [
  { href: "/ai-control-center", label: "Главная", icon: LayoutDashboard, permission: "dashboard" },
  { href: "/dashboard", label: "Аналитика", icon: BarChart2, permission: "dashboard" },
  { href: "/ads", label: "Рекламный агент", icon: Rocket, permission: "ads" },
  { href: "/ads-automation/history", label: "История запусков", icon: Megaphone, permission: "ads" },
  { href: "/services", label: "Услуги", icon: Tag, permission: "booking" },
  // Подпись зависит от ниши и подставляется при отрисовке: у клиники «Врачи и
  // график», у салона «Мастера и график». Право то же, что и у страницы, —
  // справочники, а не админ-центр.
  { href: "/staff-schedule", label: "Специалисты и график", icon: Users, permission: "directory" },
  // База клиентов по мастерам. Право booking: мастера работают с телефона, и
  // без пункта в мобильном ящике страница для них существовала бы только по
  // прямому адресу. Свою часть базы и срез номеров обеспечивает сервер.
  { href: "/client-base", label: "База клиентов", icon: Users, permission: "booking" },
  { href: "/content-studio", label: "Контент", icon: Clapperboard, permission: "ads" },
  { href: "/site-blog", label: "Сайт и блог", icon: FileText, permission: "admin" },
  { href: "/marketplace", label: "Маркет", icon: Store, permission: "marketplace" },
  { href: "/admin", label: "Настройки клиники", icon: Settings, permission: "admin" },
];

function isActive(location: string, href: string) {
  return location === href || location.startsWith(`${href}/`) || (href === "/appointments" && location === "/booking") || (href === "/ads" && location.startsWith("/ads-automation"));
}

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [, setSessionRevision] = useState(0);
  const [location, setLocation] = useLocation();
  const { signOut, user, clinicId, userRole, rolePermissions, vertical, workspacePurpose, isSigningOut, isImpersonation } = useAuth();
  const terms = termsFor(vertical);
  const contextKey = JSON.stringify([user?.id, clinicId, userRole, workspacePurpose, vertical, isSigningOut, isImpersonation,
    Object.entries(rolePermissions).sort(([left], [right]) => left.localeCompare(right))]);
  const lifetime = useRef({ key: contextKey, revision: 0, mounted: false, sdkActor: user?.id || "" });
  if (lifetime.current.key !== contextKey) {
    lifetime.current.key = contextKey;
    lifetime.current.revision++;
  }
  const revision = lifetime.current.revision;
  const isCurrent = () => lifetime.current.mounted && lifetime.current.revision === revision && Boolean(user?.id) && !isSigningOut
    && (!hasSupabaseFrontendEnv || lifetime.current.sdkActor === user?.id);
  const sheet = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const releaseModal = useRef<(() => void) | null>(null);
  const restoreDrawerFocus = useRef(false);
  const drawerOpen = useRef(open);
  drawerOpen.current = open;

  useLayoutEffect(() => {
    lifetime.current.mounted = true;
    return () => { lifetime.current.mounted = false; };
  }, []);

  useLayoutEffect(() => {
    if (!hasSupabaseFrontendEnv) return;
    let active = true;
    const subscription = sessionAuth.onAuthStateChange((_event, session) => {
      if (!active) return;
      const next = session?.user.id || "";
      if (lifetime.current.sdkActor === next) return;
      // SDK events invalidate captured actions before React can batch A/B/A.
      lifetime.current.sdkActor = next;
      lifetime.current.revision++;
      releaseModal.current?.();
      setSessionRevision(value => value + 1);
      drawerOpen.current = false;
      setOpen(false);
      setShowProfile(false);
    }).data.subscription;
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  useLayoutEffect(() => {
    drawerOpen.current = false;
    setOpen(false);
    setShowProfile(false);
  }, [contextKey]);

  useLayoutEffect(() => {
    const panel = sheet.current, overlay = backdrop.current;
    if (!open || !drawerOpen.current || !isCurrent() || !panel || !overlay) return;
    const doc = panel.ownerDocument, view = doc.defaultView;
    if (!view) return;
    const desktop = view.matchMedia("(min-width: 1024px)");
    if (desktop.matches) { drawerOpen.current = false; setOpen(false); return; }
    let active = true;
    const trigger = moreButton.current;
    const outside = new Map<Element, { inert: string | null; hidden: string | null }>();
    const scroll = { x: view.scrollX, y: view.scrollY };
    const styles: Array<{ element: HTMLElement; property: string; value: string; priority: string; owned: string }> = [];
    function lockStyle(element: HTMLElement, property: string, value: string) {
      styles.push({ element, property, value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property), owned: value });
      element.style.setProperty(property, value, "important");
    }
    function isolateBackground() {
      if (!active) return;
      for (const element of Array.from(doc.body.children)) {
        if (element === overlay || element.contains(overlay) || outside.has(element)) continue;
        outside.set(element, { inert: element.getAttribute("inert"), hidden: element.getAttribute("aria-hidden") });
        element.setAttribute("inert", "");
        element.setAttribute("aria-hidden", "true");
      }
    }
    function focusInside() {
      const button = panel!.querySelector<HTMLButtonElement>("button:not([disabled])");
      (button ?? panel!).focus({ preventScroll: true });
    }
    function containFocus(event: FocusEvent) {
      if (active && isCurrent() && drawerOpen.current && !panel!.contains(event.target as Node)) focusInside();
    }
    function containKeys(event: globalThis.KeyboardEvent) {
      if (active) drawerKeyDown(event);
    }
    function desktopChanged(event: MediaQueryListEvent) {
      if (!event.matches || !active || !isCurrent()) return;
      drawerOpen.current = false;
      setOpen(false);
    }
    // The body portal stays outside the inert application root, including when
    // another background portal mounts while the drawer is open.
    const observer = new view.MutationObserver(isolateBackground);
    observer.observe(doc.body, { childList: true });
    doc.addEventListener("focusin", containFocus, true);
    doc.addEventListener("keydown", containKeys, true);
    desktop.addEventListener("change", desktopChanged);
    focusInside();
    isolateBackground();
    lockStyle(doc.documentElement, "overflow", "hidden");
    lockStyle(doc.documentElement, "overscroll-behavior", "none");
    lockStyle(doc.body, "overflow", "hidden");
    lockStyle(doc.body, "position", "fixed");
    lockStyle(doc.body, "top", `${-scroll.y}px`);
    lockStyle(doc.body, "left", `${-scroll.x}px`);
    lockStyle(doc.body, "width", "100%");
    const release = () => {
      if (!active) return;
      active = false;
      observer.disconnect();
      doc.removeEventListener("focusin", containFocus, true);
      doc.removeEventListener("keydown", containKeys, true);
      desktop.removeEventListener("change", desktopChanged);
      for (const [element, previous] of outside) {
        if (element.getAttribute("inert") === "") {
          if (previous.inert === null) element.removeAttribute("inert"); else element.setAttribute("inert", previous.inert);
        }
        if (element.getAttribute("aria-hidden") === "true") {
          if (previous.hidden === null) element.removeAttribute("aria-hidden"); else element.setAttribute("aria-hidden", previous.hidden);
        }
      }
      for (const { element, property, value, priority, owned } of styles) {
        if (element.style.getPropertyValue(property) !== owned || element.style.getPropertyPriority(property) !== "important") continue;
        if (value) element.style.setProperty(property, value, priority); else element.style.removeProperty(property);
      }
      view.scrollTo(scroll.x, scroll.y);
      const restore = restoreDrawerFocus.current;
      restoreDrawerFocus.current = false;
      if (releaseModal.current === release) releaseModal.current = null;
      if (restore && isCurrent() && trigger?.isConnected && !trigger.closest("[inert]")) trigger.focus({ preventScroll: true });
    };
    releaseModal.current = release;
    return release;
  }, [open, contextKey]);

  function closeDrawer() {
    if (!isCurrent() || !drawerOpen.current) return;
    restoreDrawerFocus.current = true;
    drawerOpen.current = false;
    setOpen(false);
  }
  function drawerKeyDown(event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) {
    if (!isCurrent() || !drawerOpen.current) return;
    if (event.key === "Escape") { event.preventDefault(); closeDrawer(); return; }
    if (event.key !== "Tab" || !sheet.current) return;
    // All drawer controls are native buttons; document capture also handles
    // focus moved outside by code before the browser's next key event.
    const buttons = sheet.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (!first || !last) return;
    const outside = !sheet.current.contains(document.activeElement);
    if (event.shiftKey ? document.activeElement === first || outside : document.activeElement === last || outside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  const canUse = (item: MobileNavItem) =>
    workspaceAllowsRoute(workspacePurpose, userRole, item.href) && (userRole === "lead_manager"
      ? item.href === "/leads" || (workspacePurpose === "mortgage_leads" && ["/dashboard","/clients","/appointments","/tasks"].includes(item.href))
      : userRole === "owner" || userRole === "manager" || userRole === "admin" || Boolean(rolePermissions[item.permission]));
  const mortgagePrimary: MobileNavItem[] = [
    { href: '/dashboard', label: 'Главная', icon: LayoutDashboard, permission: 'crm' },
    { href: '/leads', label: 'Заявки', icon: ClipboardList, permission: 'crm' },
    { href: '/appointments', label: 'Календарь', icon: CalendarDays, permission: 'crm' },
    { href: '/tasks', label: 'Задачи', icon: ClipboardList, permission: 'crm' },
  ];
  const mortgageDrawer: MobileNavItem[] = [
    { href: '/clients', label: 'Клиенты', icon: Users, permission: 'crm' },
    { href: '/analytics', label: 'Аналитика команды', icon: BarChart2, permission: 'crm' },
    { href: '/admin', label: 'Команда', icon: Settings, permission: 'admin' },
  ];
  const visiblePrimary = (workspacePurpose === 'mortgage_leads' ? mortgagePrimary : primaryItems).filter(canUse);
  const visibleDrawer = (workspacePurpose === 'mortgage_leads' ? mortgageDrawer : drawerItems).filter(canUse);
  const moreActive = visibleDrawer.some((item) => isActive(location, item.href));
  function navigate(item: MobileNavItem, fromDrawer = false) {
    if (!isCurrent() || !canUse(item)) return;
    if (fromDrawer) { drawerOpen.current = false; setOpen(false); }
    setLocation(item.href);
  }

  return (
    <>
      {open && createPortal(
        <div ref={backdrop} className="mobile-nav-backdrop lg:hidden" onClick={closeDrawer}>
          <section ref={sheet} id="mobile-nav-drawer" className="mobile-nav-sheet" role="dialog"
            aria-modal="true" tabIndex={-1} aria-label="Разделы Medina OS" onKeyDown={drawerKeyDown} onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--negis-muted)" }}>Меню</p>
                <h2 className="mt-1 text-lg font-semibold" style={{ color: "var(--negis-text)" }}>Разделы Medina OS</h2>
              </div>
              <button type="button" className="neu-icon-btn" onClick={closeDrawer} aria-label="Закрыть меню">
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {visibleDrawer.map((item) => {
                const { href, label: staticLabel, icon: Icon } = item;
                const label = href === "/staff-schedule"
                  ? `${capitalize(terms.specialistPlural)} и график`
                  : href === "/admin"
                    ? workspacePurpose === "mortgage_leads" ? "Команда" : `Настройки ${terms.orgGenitive}`
                    : staticLabel;
                return (
                  <button
                    key={href}
                    type="button"
                    className="mobile-nav-drawer-item"
                    aria-current={isActive(location, href) ? "page" : undefined}
                    onClick={() => navigate(item, true)}
                  >
                    <Icon size={18} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>

            {/* Профиль жил только в боковом меню, а оно скрыто классом
                `hidden lg:block`: сменить себе пароль с телефона было нельзя, а
                салон работает с телефонов. Пункт стоит вне списка разделов —
                он не маршрут, а диалог, и доступен любой роли. */}
            <button
              type="button"
              className="mobile-nav-drawer-item mt-2 w-full"
              onClick={() => {
                if (!isCurrent()) return;
                // The profile must capture the retained More button, not this removed menu item.
                restoreDrawerFocus.current = true;
                drawerOpen.current = false;
                setOpen(false);
                setShowProfile(true);
              }}
            >
              <User size={18} />
              <span>Профиль и пароль</span>
            </button>

            <button
              type="button"
              className="mobile-nav-logout"
              onClick={() => {
                if (!isCurrent()) return;
                drawerOpen.current = false;
                setOpen(false);
                void signOut();
              }}
            >
              <LogOut size={18} />
              Выйти
            </button>
          </section>
        </div>, document.body
      )}

      {showProfile && <ProfileDialog onClose={() => { if (isCurrent()) setShowProfile(false); }} />}

      <nav className="mobile-bottom-nav lg:hidden" aria-label="Основная мобильная навигация">
        {visiblePrimary.map((item) => {
          const { href, label, icon: Icon } = item;
          const active = isActive(location, href);
          return (
            <button
              key={href}
              type="button"
              className={`mobile-bottom-nav-item ${active ? "is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => navigate(item)}
            >
              <Icon size={20} />
              <span>{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          ref={moreButton}
          className={`mobile-bottom-nav-item ${open || moreActive ? "is-active" : ""}`}
          aria-expanded={open}
          aria-controls="mobile-nav-drawer"
          aria-label="Ещё разделы"
          onClick={() => { if (isCurrent()) setOpen(true); }}
        >
          <Menu size={20} />
          <span>Ещё</span>
        </button>
      </nav>
    </>
  );
}
