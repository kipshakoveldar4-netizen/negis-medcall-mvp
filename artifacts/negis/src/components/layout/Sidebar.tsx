import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { BadgeDollarSign, BarChart2, Building2, CalendarDays, Clapperboard, Inbox, LayoutDashboard, Rocket, Settings, Store, Tag, Users, LogOut, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { isRealWorkspace } from '@/lib/demoStorage';
import { capitalize, termsFor } from '../../../../../lib/vertical/terms';
import { ProfileDialog } from './ProfileDialog';
import { loginFromEmail } from '../../../../../lib/auth/staff-logins';

// Medina OS information architecture (UI-1). Groups map only to routes that
// exist; role arrays are unchanged from the previous IA. The former disabled
// "AI-сотрудники" item was removed — future modules are documented in the audit,
// not rendered as dead navigation.
// NOTE: this is one of the two navigation surfaces (the other is MobileNav).
// Keep their route sets in sync — smoke-negis-routes.ts and
// medina-commercial.test.ts assert on both files.
type NavItem = { href: string; icon: LucideIcon; label: string; roles: string[] };
type NavGroup = { title: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Обзор',
    items: [
      { href: '/ai-control-center', icon: LayoutDashboard, label: 'Главная', roles: ['owner', 'manager'] },
      { href: '/dashboard', icon: BarChart2, label: 'Аналитика', roles: ['owner', 'manager'] },
    ],
  },
  {
    title: 'Операции',
    items: [
      { href: '/leads', icon: Inbox, label: 'Заявки', roles: ['owner', 'manager', 'agent'] },
      { href: '/clients', icon: Users, label: 'Клиенты', roles: ['owner', 'manager', 'agent'] },
      { href: '/appointments', icon: CalendarDays, label: 'Записи', roles: ['owner', 'manager', 'agent', 'booking_agent'] },
      { href: '/sales', icon: BadgeDollarSign, label: 'Продажи', roles: ['owner', 'manager', 'agent'] },
      // Услуги стоят в «Операциях», а не в «Управлении»: право на чтение здесь
      // то же, что у записей, и справочник открывают в момент записи пациента.
      { href: '/services', icon: Tag, label: 'Услуги', roles: ['owner', 'manager', 'agent', 'booking_agent'] },
      // Регистратор (в салоне — администратор) правит исполнителей и смены сам:
      // право manage_directory даёт ему эту страницу, не открывая админ-центр.
      { href: '/staff-schedule', icon: CalendarDays, label: 'Специалисты и график', roles: ['owner', 'manager', 'receptionist'] },
      // «Кто чей клиент». Единственный пункт, который видит и мастер, и
      // администратор: у мастера это его собственная база без номеров.
      { href: '/client-base', icon: Users, label: 'База клиентов', roles: ['owner', 'manager', 'receptionist', 'agent', 'doctor', 'booking_agent'] },
    ],
  },
  {
    title: 'Рост',
    items: [
      { href: '/ads-automation', icon: Rocket, label: 'Реклама', roles: ['owner', 'manager'] },
      { href: '/content-studio', icon: Clapperboard, label: 'Контент', roles: ['owner', 'manager'] },
      // Маркет был недостижим: маршрут объявлен, а ссылки на него не было ни в
      // боковом меню, ни в мобильном — страница открывалась только вводом
      // адреса. Панель платформы сюда не ставится намеренно: она не экран
      // клиники, и ссылка на неё вела бы всех остальных в «страницы нет».
      { href: '/marketplace', icon: Store, label: 'Маркет', roles: ['owner', 'manager'] },
    ],
  },
  {
    title: 'Управление',
    items: [
      { href: '/admin', icon: Settings, label: 'Настройки', roles: ['owner', 'manager'] },
    ],
  },
];

export function Sidebar() {
  const [location] = useLocation();
  const { signOut, user, userRole, availableWorkspaces, clearWorkspaceSelection, vertical } = useAuth();

  // Подпись «работаем без базы клиники» вешалась на isDemoMode, а он не
  // становится истинным никогда: флаг включается только из сохранённой сессии
  // с mode:'demo', а такую сессию в репозитории никто не записывает — ключи
  // только читаются и удаляются. То есть подпись стояла на ветке, до которой
  // выполнение не доходит, и оператор не видел её ни разу.
  //
  // Достижимое условие — рабочее пространство не выбрано: тогда экраны берут
  // данные из браузера, а не из базы, и сказать об этом обязательно.
  const noClinicSelected = !isRealWorkspace();
  const terms = termsFor(vertical);
  const [showProfile, setShowProfile] = useState(false);

  const canUse = (item: NavItem) =>
    !userRole || userRole === 'owner' || userRole === 'manager' || userRole === 'admin' || item.roles.includes(userRole);
  const visibleGroups = NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter(canUse) }))
    .filter((group) => group.items.length > 0);

  const initials = (user?.user_metadata?.full_name ?? user?.email ?? 'U')
    .split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();

  const openProfile = () => setShowProfile(true);

  return (
    <>
      <aside
        className="fixed bottom-4 left-4 top-4 z-20 flex w-[236px] select-none flex-col overflow-hidden rounded-[28px]"
        style={{ background: 'var(--negis-dark)', boxShadow: 'var(--negis-shadow-lift)' }}
      >
        {/* Brand */}
        <div className="flex h-[68px] shrink-0 items-center gap-3 px-5">
          <div
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold"
            style={{ background: 'var(--negis-mint)', color: 'var(--negis-mint-ink)' }}
          >
            M
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" style={{ color: 'var(--negis-dark-text)' }}>Medina OS</p>
            <p className="mt-0.5 truncate text-[11px] font-medium" style={{ color: 'var(--negis-dark-muted)' }}>
              {noClinicSelected ? 'Пробный доступ' : 'Медицинская CRM'}
            </p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 pb-4 pt-3" aria-label="Основная навигация">
          {visibleGroups.map((group) => (
            <div key={group.title} className="mb-4">
              <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--negis-dark-muted)' }}>
                {group.title}
              </p>
              <div className="flex flex-col gap-0.5">
                {group.items.map(({ href, icon: Icon, label: staticLabel }) => {
                  // Единственный пункт, чья подпись зависит от ниши: у клиники
                  // это врачи, у салона — мастера. Словарь один — lib/vertical.
                  const label = href === '/staff-schedule'
                    ? `${capitalize(terms.specialistPlural)} и график`
                    : staticLabel;
                  const active = location === href || location.startsWith(href + '/');
                  return (
                    <Link key={href} href={href}>
                      <div
                        className="flex min-h-[42px] cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors"
                        data-active={active}
                        style={{
                          background: active ? 'var(--negis-mint)' : 'transparent',
                          color: active ? 'var(--negis-mint-ink)' : 'var(--negis-dark-muted)',
                          fontWeight: active ? 620 : 500,
                        }}
                      >
                        <Icon size={18} strokeWidth={active ? 2 : 1.75} aria-hidden />
                        <span className="truncate">{label}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Profile */}
        <div className="flex shrink-0 items-center gap-3 px-4 pb-4 pt-3" style={{ borderTop: '1px solid var(--negis-dark-line)' }}>
          <button
            type="button"
            onClick={openProfile}
            aria-label="Открыть профиль"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold transition-colors"
            style={{ background: 'var(--negis-dark-line)', color: 'var(--negis-dark-text)' }}
          >
            {initials}
          </button>
          <button type="button" onClick={openProfile} className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-semibold" style={{ color: 'var(--negis-dark-text)' }}>{user?.user_metadata?.full_name || 'Профиль'}</p>
            <p className="truncate text-xs" style={{ color: 'var(--negis-dark-muted)' }}>{loginFromEmail(user?.email) || 'вход не выполнен'}</p>
          </button>
          {availableWorkspaces.length > 1 && (
            // Selection-1: without this the first choice was permanent — the
            // stored selector is reapplied on every sign-in, so signing out did
            // not return anyone to the picker.
            <button
              type="button"
              onClick={clearWorkspaceSelection}
              aria-label="Сменить клинику"
              title="Сменить клинику"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:text-white"
              style={{ color: 'var(--negis-dark-muted)' }}
            >
              <Building2 size={17} aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={signOut}
            aria-label="Выйти"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:text-red-400"
            style={{ color: 'var(--negis-dark-muted)' }}
          >
            <LogOut size={17} aria-hidden />
          </button>
        </div>
      </aside>

      {showProfile && <ProfileDialog onClose={() => setShowProfile(false)} />}
    </>
  );
}
