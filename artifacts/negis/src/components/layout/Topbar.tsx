import { useLocation } from 'wouter';

// Security-1A: the notification bell was removed.
//
// It was backed by a `bookings` realtime subscription plus an `agents` lookup,
// and neither table exists in the production Supabase project — so every load
// failed and no notification could ever arrive. Rather than keep a bell that
// implies live booking alerts, the Topbar now shows only page context and the
// date. A notification surface can return once a real notification provider
// exists (see the Security-1A report). No fabricated notifications.

const PAGE_LABELS: Record<string, string> = {
  '/ai-control-center': 'Главная',
  '/content-studio': 'Контент',
  '/ai-content-studio': 'Контент',
  '/content': 'Контент',
  '/studio': 'Контент',
  '/appointments': 'Записи',
  '/leads': 'Заявки',
  '/clients': 'Клиенты',
  '/dashboard': 'Аналитика',
  '/booking': 'Записи',
  '/sales': 'Продажи',
  '/ads-automation': 'Реклама',
  '/ads-automation/history': 'История запусков',
  '/onboarding': 'Настройка клиники',
  '/admin': 'Настройки',
};

export function Topbar() {
  const [location] = useLocation();

  const cleanLocation = location.split('?')[0];
  const pageLabel = PAGE_LABELS[cleanLocation] ?? 'Medina OS';

  const today = new Date().toLocaleDateString('ru', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <header
      className="negis-topbar sticky top-0 z-30 flex shrink-0 items-center gap-4 px-5 md:px-8"
      style={{
        background: 'var(--ng-surface)',
        borderBottom: '1px solid var(--ng-border)',
      }}
    >
      <div className="flex min-w-0 items-center gap-2 select-none">
        <span className="text-xs font-semibold tracking-[0.06em]" style={{ color: 'var(--ng-primary)' }}>
          Medina OS
        </span>
        <span aria-hidden style={{ color: 'var(--ng-border)', fontSize: 14 }}>/</span>
        <span className="truncate text-xs font-semibold tracking-[0.04em]" style={{ color: 'var(--ng-text-2)' }}>
          {pageLabel}
        </span>
      </div>

      <div className="negis-topbar-actions ml-auto flex min-w-0 items-center justify-end gap-4">
        <span
          className="negis-topbar-date"
          style={{
            fontSize: 12,
            color: 'var(--ng-muted)',
            letterSpacing: '0.01em',
          }}
        >
          {today}
        </span>
      </div>
    </header>
  );
}
