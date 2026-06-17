import { Link } from "wouter";

export default function Privacy() {
  return (
    <LegalPage title="Политика конфиденциальности — Negis" heading="Политика конфиденциальности" updated="17 мая 2026">
      <p style={P}>
        Negis — CRM и система автоматизации для клиник. Мы обрабатываем данные, которые пользователи и клиники передают при использовании сервиса.
      </p>

      <Section title="1. Какие данные мы собираем">
        <ul style={UL}>
          <li style={LI}>имя;</li>
          <li style={LI}>телефон;</li>
          <li style={LI}>email;</li>
          <li style={LI}>название клиники;</li>
          <li style={LI}>данные сотрудников клиники;</li>
          <li style={LI}>данные клиентов/лидов;</li>
          <li style={LI}>записи на услуги;</li>
          <li style={LI}>источники заявок;</li>
          <li style={LI}>технические данные, необходимые для работы сервиса.</li>
        </ul>
      </Section>

      <Section title="2. Для чего используются данные">
        <ul style={UL}>
          <li style={LI}>для работы CRM;</li>
          <li style={LI}>для создания и обработки лидов;</li>
          <li style={LI}>для записи клиентов на услуги;</li>
          <li style={LI}>для управления сотрудниками и филиалами;</li>
          <li style={LI}>для аналитики;</li>
          <li style={LI}>для связи с пользователем;</li>
          <li style={LI}>для улучшения качества сервиса.</li>
        </ul>
      </Section>

      <Section title="3. Передача данных третьим лицам">
        <p style={P}>
          Мы не продаём персональные данные. Данные могут передаваться только сервисам, необходимым для работы Negis, например хостингу, базе данных, уведомлениям, аналитике и рекламным интеграциям, если они подключены пользователем.
        </p>
      </Section>

      <Section title="4. Интеграции с Meta/Facebook">
        <p style={P}>
          Если клиника подключает Facebook или Instagram Ads, Negis может получать рекламные данные, статистику, лиды и информацию, необходимую для обработки заявок. Эти данные используются только внутри аккаунта клиники.
        </p>
      </Section>

      <Section title="5. Хранение и защита данных">
        <p style={P}>
          Мы принимаем разумные технические меры для защиты данных от несанкционированного доступа, изменения или удаления.
        </p>
      </Section>

      <Section title="6. Удаление данных">
        <p style={P}>
          Пользователь может запросить удаление данных по инструкции на странице:{' '}
          <a href="https://www.negis.online/data-deletion" style={A}>https://www.negis.online/data-deletion</a>
        </p>
      </Section>

      <Section title="7. Контакты" last>
        <p style={P}>
          По вопросам конфиденциальности:{' '}
          <a href="mailto:agentconcept01@gmail.com" style={A}>agentconcept01@gmail.com</a>
        </p>
      </Section>
    </LegalPage>
  );
}

/* ─── Shared primitives ─────────────────────────────────── */
const P: React.CSSProperties = { margin: '0 0 12px', fontSize: 15, color: '#475569', lineHeight: 1.75 };
const UL: React.CSSProperties = { margin: '0', padding: '0 0 0 20px' };
const LI: React.CSSProperties = { marginBottom: 8, color: '#475569', fontSize: 15, lineHeight: 1.6 };
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

/* ─── Shared layout ─────────────────────────────────────── */
function LegalPage({ title, heading, updated, children }: {
  title: string; heading: string; updated: string; children: React.ReactNode;
}) {
  return (
    <>
      <title>{title}</title>
      <div style={{ minHeight: '100vh', background: '#F4F7FB', padding: '40px 16px 60px', fontFamily: "'Inter', sans-serif" }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>

          {/* Logo + back */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
            <Link href="/" style={{ textDecoration: 'none' }}>
              <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: '0.15em', color: '#0B1220' }}>NEGIS</span>
            </Link>
            <Link href="/" style={{ color: '#64748B', fontSize: 14, textDecoration: 'none' }}>
              На главную
            </Link>
          </div>

          {/* Card */}
          <div style={{
            background: '#FFFFFF', borderRadius: 20, padding: '48px 52px',
            boxShadow: '6px 6px 16px #C8CDD4, -6px -6px 16px #FFFFFF',
          }}>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: '#0B1220', margin: '0 0 8px' }}>{heading}</h1>
            <p style={{ fontSize: 13, color: '#94A3B8', margin: '0 0 44px' }}>Дата обновления: {updated}</p>

            {children}

            {/* Footer links */}
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
