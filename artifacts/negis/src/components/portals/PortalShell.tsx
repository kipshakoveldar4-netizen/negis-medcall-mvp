import { useId, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowUpRight, LogOut, Menu, type LucideIcon } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import "./portal-workspace.css";

export type PortalNavItem = { id: string; label: string; icon: LucideIcon; href?: string };
export type PortalShellProps = {
  title: string;
  homeHref?: string;
  roleLabel: string;
  displayName?: string;
  items: PortalNavItem[];
  activeId: string;
  onNavigate: (id: string) => void;
  onSignOut?: () => void;
  actions?: ReactNode;
  children: ReactNode;
};

export function PortalShell({ title, homeHref = "/", roleLabel, displayName, items, activeId, onNavigate, onSignOut, actions, children }: PortalShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const contentId = useId();
  const initials = displayName?.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join("") ?? "";
  const navigate = (id: string) => { setMenuOpen(false); onNavigate(id); };
  const navigation = <>
    <Link href={homeHref} className="portal-brand" onClick={() => navigate(items[0]?.id ?? activeId)}><img src="/favicon.svg" width={34} height={34} alt=""/><span>Medina OS</span></Link>
    <p className="portal-role">{roleLabel}</p>
    <nav aria-label={roleLabel} className="portal-nav">{items.map(({ id, label, icon: Icon, href }) => href
      ? <Link key={id} href={href} className="portal-nav-item"><Icon size={19} aria-hidden="true"/><span>{label}</span><ArrowUpRight size={14} className="portal-nav-external" aria-hidden="true"/></Link>
      : <button key={id} type="button" className="portal-nav-item" aria-current={id === activeId ? "page" : undefined} onClick={() => navigate(id)}><Icon size={19} aria-hidden="true"/><span>{label}</span></button>)}</nav>
    <div className="portal-sidebar-bottom">
      {displayName && <div className="portal-identity"><span className="portal-avatar" aria-hidden="true">{initials}</span><div><strong>{displayName}</strong><span>{roleLabel}</span></div></div>}
      {onSignOut && <button type="button" className="portal-signout" title="Выйти из аккаунта" aria-label="Выйти из аккаунта" onClick={onSignOut}><LogOut size={19}/></button>}
    </div>
    <footer className="portal-legal"><Link href="/privacy">Конфиденциальность</Link><Link href="/terms">Условия</Link></footer>
  </>;
  return <div className="portal-workspace">
    <a className="portal-skip" href={`#${contentId}`}>К содержимому</a>
    <aside className="portal-sidebar">{navigation}</aside>
    <div className="portal-main-column">
      <header className="portal-page-header">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild><button type="button" className="portal-menu-button" title="Открыть меню" aria-label="Открыть меню"><Menu size={21}/></button></SheetTrigger>
          <SheetContent side="left" className="portal-drawer"><SheetTitle className="sr-only">Меню кабинета</SheetTitle><SheetDescription className="sr-only">Разделы Medina OS</SheetDescription>{navigation}</SheetContent>
        </Sheet>
        <h1>{title}</h1>
        <time className="portal-header-date" dateTime={new Date().toISOString()}>{new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date())}</time>
        {actions && <div className="portal-header-actions">{actions}</div>}
      </header>
      <main id={contentId} tabIndex={-1} className="portal-content">{children}</main>
    </div>
  </div>;
}
