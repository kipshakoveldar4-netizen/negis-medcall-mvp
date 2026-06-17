import { Link } from "wouter";

export default function Terms() {
  return (
    <LegalPage title="Пользовательское соглашение — Negis" heading="Пользовательское соглашение" updated="17 мая 2026">
      <p style={P}>
        Настоящее пользовательское соглашение регулирует использование сервиса Negis.
      </p>

      <Section title="1. О сервисе">
        <p style={P}>
          Negis предоставляет CRM и инструменты автоматизации для клиник: управление лидами, запись клиентов, сотрудники, роли, филиалы, аналитика и интеграции.
        </p>
      </Section>

      <Section title="2. Аккаунт пользователя">
        <p style={P}>
          Пользователь отвечает за корректность данных, безопасность логина и пароля, а также за действия, совершённые в аккаунте.
        </p>
      </Section>

      <Section title="3. Данные клиники и клиентов">
        <p style={P}>
          Клиника самостоятельно отвечает за законность обработки данных своих клиентов и сотрудников. Negis предоставляет технический инструмент для хранения и обработки таких данных.
        </p>
      </Section>

      <Section title="4. Использование интеграций">
        <p style={P}>
          При подключении Facebook, Instagram, TikTok, WhatsApp, Telegram или других интеграций пользователь подтверждает, что имеет право использовать соответствующие аккаунты и данные.
        </p>
      </Section>

      <Section title="5. Ограничения">
        <p style={P}>
          Запрещено использовать сервис для незаконной деятельности, рассылки спама, нарушения прав третьих лиц или попыток несанкционированного доступа.
        </p>
      </Section>

      <Section title="6. Тарифы и оплата">
        <p style={P}>
          Negis может предоставлять бесплатный пробный период и платные тарифы. Условия тарифов могут изменяться и отображаются на сайте.
        </p>
      </Section>

      <Section title="7. Ограничение ответственности">
        <p style={P}>
          Negis не несёт ответственности за ошибки, вызванные неверными данными пользователя, сбоями сторонних сервисов или неправомерным использованием системы.
        </p>
      </Section>

      <Section title="8. Изменения соглашения">
        <p style={P}>
          Мы можем обновлять соглашение. Актуальная версия публикуется на этой странице.
        </p>
      </Section>

      <Section title="9. Контакты" last>
        <p style={P}>
          <a href="mailto:agentconcept01@gmail.com" style={A}>agentconcept01@gmail.com</a>
        </p>
      </Section>
    </LegalPage>
  );
}

/* ─── Shared primitives ─────────────────────────────────── */
const P: React.CSSProperties = { margin: '0 0 12px', fontSize: 15, color: '#475569', lineHeight: 1.75 };
const A: React.CSSProperties = { color: '#1A56DB', textDecoration: 'none' };

function Section({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ marginBottom: 36 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0B1220', margin: '0 0 12px' }}>{title}</h2>
      <div style={{ fontSize: 15, color: '#475569', lineHeight: 1.75 }}>{children}</div>
      {!last && <div style={{ height: 1, background: '#F1F5F9', marginTop: 32 }} />}
    </div>
  );
}

function LegalPage({ title, heading, updated, children }: {
  title: string; heading: string; updated: string; children: React.ReactNode;
}) {
  return (
    <>
      <title>{title}</title>
      <div style={{ minHeight: '100vh', background: '#F4F7FB', padding: '40px 16px 60px', fontFamily: "'Inter', sans-serif" }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
            <Link href="/" style={{ textDecoration: 'none' }}>
              <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: '0.15em', color: '#0B1220' }}>NEGIS</span>
            </Link>
            <Link href="/" style={{ color: '#64748B', fontSize: 14, textDecoration: 'none' }}>
              На главную
            </Link>
          </div>

          <div style={{
            background: '#FFFFFF', borderRadius: 20, padding: '48px 52px',
            boxShadow: '6px 6px 16px #C8CDD4, -6px -6px 16px #FFFFFF',
          }}>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: '#0B1220', margin: '0 0 8px' }}>{heading}</h1>
            <p style={{ fontSize: 13, color: '#94A3B8', margin: '0 0 44px' }}>Дата обновления: {updated}</p>

            {children}

            <div style={{
              borderTop: '1px solid #E7ECF3', paddingTop: 24, marginTop: 8,
              display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', justifyContent: 'center',
            }}>
              <Link href="/privacy" style={{ color: '#94A3B8', fontSize: 13, textDecoration: 'none' }}>Privacy</Link>
              <span style={{ color: '#E7ECF3' }}>·</span>
              <Link href="/terms" style={{ color: '#94A3B8', fontSize: 13, textDecoration: 'none' }}>Terms</Link>
              <span style={{ color: '#E7ECF3' }}>·</span>
              <Link href="/data-deletion" style={{ color: '#94A3B8', fontSize: 13, textDecoration: 'none' }}>Data Deletion</Link>
              <span style={{ color: '#E7ECF3' }}>·</span>
              <span style={{ color: '#B0BAC6', fontSize: 13 }}>© 2026 Negis</span>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
