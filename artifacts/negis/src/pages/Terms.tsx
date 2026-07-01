import { Link } from "wouter";

export default function Terms() {
  return (
    <LegalPage title="Условия использования Negis" heading="Условия использования Negis" updated="1 июля 2026">
      <p style={P}>
        Настоящие условия описывают базовые правила использования сервиса Negis. Это MVP-текст для публикации и проверки приложения Meta; финальный договор может быть уточнён отдельно.
      </p>

      <Section title="1. О сервисе">
        <p style={P}>
          Negis помогает клиникам управлять CRM, заявками, клиентами, записью, задачами, контентом и рекламой. Сервис может включать AI-инструменты, интеграции с Supabase, Telegram, Meta/Facebook/Instagram и OpenAI.
        </p>
      </Section>

      <Section title="2. Ответственность пользователя">
        <p style={P}>
          Пользователь и клиника отвечают за корректность данных, медицинских формулировок, рекламных обещаний, офферов, цен, противопоказаний и другой информации, которую они вводят или подтверждают в Negis.
        </p>
      </Section>

      <Section title="3. CRM, клиенты и сотрудники">
        <p style={P}>
          Клиника самостоятельно отвечает за законность обработки данных своих клиентов, пациентов и сотрудников. Negis предоставляет технический инструмент для хранения, обработки и организации таких данных внутри рабочего пространства клиники.
        </p>
      </Section>

      <Section title="4. Реклама и ручное подтверждение">
        <p style={P}>
          Запуск рекламы требует ручного подтверждения пользователем. ACTIVE запуск рекламы требует отдельного явного подтверждения. Пользователь должен проверить текст, бюджет, целевую страницу, креатив, аудиторию и соответствие требованиям рекламных площадок до запуска.
        </p>
      </Section>

      <Section title="5. Правила Meta и результат рекламы">
        <p style={P}>
          Meta/Facebook/Instagram может отклонять объявления, креативы, аудитории или кампании по своим правилам. Negis не гарантирует одобрение рекламы, количество заявок, стоимость лида, продажи, запись пациентов или иной коммерческий результат.
        </p>
      </Section>

      <Section title="6. Рекламный бюджет">
        <p style={P}>
          Рекламный бюджет оплачивается отдельно в Meta рекламном аккаунте клиента. Negis не является платёжным посредником Meta и не управляет списаниями рекламного кабинета, кроме технической передачи параметров кампании при подтверждённом запуске.
        </p>
      </Section>

      <Section title="7. Использование интеграций">
        <p style={P}>
          При подключении Facebook, Instagram, Telegram, Supabase, OpenAI или других интеграций пользователь подтверждает, что имеет право использовать соответствующие аккаунты, данные, токены и материалы.
        </p>
      </Section>

      <Section title="8. Ограничения">
        <p style={P}>
          Запрещено использовать сервис для незаконной деятельности, спама, нарушения прав третьих лиц, публикации недостоверных медицинских обещаний или попыток несанкционированного доступа.
        </p>
      </Section>

      <Section title="9. Ограничение ответственности">
        <p style={P}>
          Negis предоставляется как рабочий инструмент. Сервис не заменяет юридическую, медицинскую, рекламную или финансовую экспертизу. Пользователь принимает решения о публикации рекламы и использовании данных самостоятельно.
        </p>
      </Section>

      <Section title="10. Изменения условий">
        <p style={P}>
          Мы можем обновлять условия использования. Актуальная версия публикуется на этой странице.
        </p>
      </Section>

      <Section title="11. Контакты" last>
        <p style={P}>
          По вопросам условий использования:{' '}
          <a href="mailto:kipshakoveldar4@gmail.com" style={A}>kipshakoveldar4@gmail.com</a>
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
