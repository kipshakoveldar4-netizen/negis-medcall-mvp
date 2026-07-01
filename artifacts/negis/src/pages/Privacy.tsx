import { Link } from "wouter";

export default function Privacy() {
  return (
    <LegalPage title="Политика конфиденциальности Negis" heading="Политика конфиденциальности Negis" updated="1 июля 2026">
      <p style={P}>
        Negis / Concept Med / MedCall AI предоставляет CRM и инструменты автоматизации для клиник. Оператором сервиса на этапе MVP является Negis. Эта политика описывает, какие данные могут обрабатываться при использовании CRM, рекламных модулей и интеграций.
      </p>

      <Section title="1. Какие данные обрабатываются">
        <ul style={UL}>
          <li style={LI}>данные клиники: название, город, услуги, рабочие настройки и CRM-структура;</li>
          <li style={LI}>данные сотрудников: имя, email, роль, права доступа и рабочие действия в системе;</li>
          <li style={LI}>контактные данные клиентов или пациентов, если клиника самостоятельно вносит их в CRM;</li>
          <li style={LI}>заявки, звонки, записи, задачи, сообщения и отчёты внутри CRM;</li>
          <li style={LI}>рекламные настройки: кампании, бюджеты, аудитории, статусы запусков и результаты проверок;</li>
          <li style={LI}>креативы: изображения, видео, тексты объявлений, сценарии и промпты;</li>
          <li style={LI}>Meta/Facebook/Instagram identifiers: business id, ad account id, page id, campaign id, ad set id, creative id, ad id и связанные технические идентификаторы;</li>
          <li style={LI}>технические данные: IP-адрес, сведения о браузере, логи ошибок, события безопасности и данные, необходимые для стабильной работы сервиса.</li>
        </ul>
      </Section>

      <Section title="2. Для чего используются данные">
        <ul style={UL}>
          <li style={LI}>для работы CRM, управления лидами, клиентами, задачами и коммуникациями;</li>
          <li style={LI}>для записи клиентов, работы ресепшена и контроля расписания;</li>
          <li style={LI}>для запуска, проверки и анализа рекламы в Meta/Facebook/Instagram;</li>
          <li style={LI}>для подготовки отчётов, аналитики и истории рекламных запусков;</li>
          <li style={LI}>для работы интеграций с Supabase, Telegram, Meta и OpenAI;</li>
          <li style={LI}>для диагностики ошибок, защиты аккаунтов и улучшения качества сервиса.</li>
        </ul>
      </Section>

      <Section title="3. Интеграции и сторонние сервисы">
        <p style={P}>
          Negis не продаёт персональные данные. Данные могут передаваться только сервисам, необходимым для работы продукта: Supabase для хранения данных и файлов, Telegram для уведомлений или передачи контента, Meta для рекламных кампаний и OpenAI для генерации или анализа текстов. Передача происходит только в объёме, необходимом для выбранной функции.
        </p>
      </Section>

      <Section title="4. Реклама и Meta/Facebook/Instagram">
        <p style={P}>
          Если клиника подключает Meta/Facebook/Instagram Ads, Negis может использовать идентификаторы рекламного аккаунта, страницы, кампаний, групп объявлений, объявлений и креативов для создания, проверки, остановки или анализа рекламы. Рекламные бюджеты оплачиваются через Meta аккаунт клиента и не включаются в оплату Negis.
        </p>
      </Section>

      <Section title="5. Секретные ключи и токены">
        <p style={P}>
          Секретные ключи, service role keys, access tokens и app secrets используются только на серверной стороне. Они не показываются обычным пользователям в интерфейсе Negis. В интерфейсе могут отображаться только безопасные технические признаки, например факт наличия ключа или публичные идентификаторы аккаунтов.
        </p>
      </Section>

      <Section title="6. Хранение и защита данных">
        <p style={P}>
          Мы принимаем разумные технические меры для защиты данных от несанкционированного доступа, изменения или удаления. Доступ к рабочему пространству ограничивается ролями сотрудников и настройками клиники.
        </p>
      </Section>

      <Section title="7. Удаление данных">
        <p style={P}>
          Пользователь или представитель клиники может запросить удаление данных по email:{' '}
          <a href="mailto:kipshakoveldar4@gmail.com" style={A}>kipshakoveldar4@gmail.com</a>. Также доступна страница с инструкцией:{' '}
          <Link href="/data-deletion" style={A}>/data-deletion</Link>.
        </p>
      </Section>

      <Section title="8. Контакты" last>
        <p style={P}>
          По вопросам конфиденциальности:{' '}
          <a href="mailto:kipshakoveldar4@gmail.com" style={A}>kipshakoveldar4@gmail.com</a>
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
