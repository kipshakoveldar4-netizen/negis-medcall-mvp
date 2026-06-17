import { Link } from "wouter";

export default function DataDeletion() {
  return (
    <LegalPage title="Удаление данных пользователя — Negis" heading="Удаление данных пользователя" updated="17 мая 2026">

      <p style={P}>
        Если вы хотите удалить свои данные из Negis, отправьте запрос на email:{' '}
        <a href="mailto:agentconcept01@gmail.com" style={A}>agentconcept01@gmail.com</a>
      </p>

      <Section title="В письме укажите">
        <ul style={UL}>
          <li style={LI}>ваше имя;</li>
          <li style={LI}>email или телефон;</li>
          <li style={LI}>название клиники;</li>
          <li style={LI}>какие данные вы хотите удалить;</li>
          <li style={LI}>что запрос связан с удалением данных из Negis.</li>
        </ul>
      </Section>

      <Section title="Сроки обработки">
        <p style={P}>
          Мы обработаем запрос и удалим связанные данные в течение 30 дней, если хранение этих данных не требуется по закону или договорным обязательствам.
        </p>
      </Section>

      <Section title="Данные из Facebook / Instagram Lead Ads">
        <p style={P}>
          Если ваши данные были получены через Facebook или Instagram Lead Ads, укажите это в запросе. Мы удалим связанные лиды и рекламные данные из аккаунта клиники в Negis.
        </p>
      </Section>

      <Section title="Запрос на английском" last>
        <div style={{
          background: '#F8FAFC', border: '1px solid #E7ECF3', borderRadius: 12,
          padding: '16px 20px', fontSize: 14, color: '#475569', lineHeight: 1.7,
        }}>
          To request deletion of your data from Negis, please email{' '}
          <a href="mailto:agentconcept01@gmail.com" style={A}>agentconcept01@gmail.com</a>{' '}
          with your name, contact details, clinic name, and a clear request to delete your data.
          We will process the request within 30 days.
        </div>
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
