import { Link } from "wouter";
import "./legal.css";

export default function Privacy() {
  return (
    <LegalPage title="Политика конфиденциальности Medina OS" heading="Политика конфиденциальности Medina OS" updated="24 октября 2026">
      <p style={P}>
        Medina OS предоставляет CRM и инструменты автоматизации для бизнеса, включая клиники, салоны и ипотечные команды. Эта политика описывает, какие данные могут обрабатываться при использовании CRM, рекламных модулей и подключённых интеграций.
      </p>

      <Section title="1. Какие данные обрабатываются">
        <ul style={UL}>
          <li style={LI}>данные организации: название, город, услуги, рабочие настройки и CRM-структура;</li>
          <li style={LI}>данные сотрудников: имя, email, роль, права доступа и рабочие действия в системе;</li>
          <li style={LI}>контактные данные клиентов, пациентов или ипотечных заявителей, внесённые в CRM или поступившие через подключённые каналы;</li>
          <li style={LI}>заявки, в том числе ипотечные, сделки, звонки, записи, задачи, сообщения и отчёты внутри CRM в зависимости от используемых модулей;</li>
          <li style={LI}>рекламные настройки: кампании, бюджеты, аудитории, статусы запусков и результаты проверок;</li>
          <li style={LI}>креативы: изображения, видео, тексты объявлений, сценарии и промпты;</li>
          <li style={LI}>Meta/Facebook/Instagram identifiers: business id, ad account id, page id, campaign id, ad set id, creative id, ad id и связанные технические идентификаторы;</li>
          <li style={LI}>технические данные: IP-адрес, сведения о браузере, логи ошибок, события безопасности и данные, необходимые для стабильной работы сервиса.</li>
        </ul>
        <p style={P}>
          Если включена форма прямой заявки с сайта, она передаёт имя, название бизнеса, телефон или другой предусмотренный формой контакт, выбранные услуги, путь страницы и версию согласия. На сервере сохраняется запись приёма заявки и согласия для обработки обращения и обратной связи. Согласие в форме относится к этой цели, а не ко всем операциям CRM или интеграций; эта политика не подтверждает, что согласия существующих клиентов уже получены.
        </p>
      </Section>

      <Section title="2. Для чего используются данные">
        <ul style={UL}>
          <li style={LI}>для работы CRM, управления лидами, клиентами, задачами и коммуникациями;</li>
          <li style={LI}>для записи клиентов, работы ресепшена и контроля расписания;</li>
          <li style={LI}>для запуска, проверки и анализа рекламы в Meta/Facebook/Instagram;</li>
          <li style={LI}>для подготовки отчётов, аналитики и истории рекламных запусков;</li>
          <li style={LI}>для обработки прямых заявок с сайта и обратной связи, если форма включена;</li>
          <li style={LI}>для работы подключённых интеграций с Supabase, Telegram, Meta, OpenAI и другими используемыми провайдерами;</li>
          <li style={LI}>для диагностики ошибок, защиты аккаунтов и улучшения качества сервиса.</li>
        </ul>
      </Section>

      <Section title="3. Интеграции и сторонние сервисы">
        <p style={P}>
          Medina OS не продаёт персональные данные. В зависимости от выбранной функции данные могут обрабатываться внешними провайдерами: Supabase для хранения данных и файлов, Meta для рекламных кампаний и OpenAI для генерации или анализа текстов.
        </p>
        <p style={P}>
          Если подключён приём входящих сообщений через Wazzup, CRM может получать содержимое сообщений, контакты отправителей и технические идентификаторы канала. Telegram используется опционально: при включённой интеграции туда может передаваться содержимое выбранного уведомления или материала.
        </p>
        <p style={P}>
          Если включена защита формы Cloudflare Turnstile, она может загружаться и обрабатывать технические данные запроса до установки флажка согласия в форме. Флажок относится к отправке контактной заявки и не является общим согласием на обработку данных всеми провайдерами.
        </p>
        <p style={P}>
          Фактические условия обработки данных внешними провайдерами, места хранения и передачи данных требуют отдельной проверки для выбранного развёртывания и подключённых сервисов. Эта страница не подтверждает размещение данных в Казахстане или соответствие законодательству Казахстана.
        </p>
        <p style={P}>
          Для статистики посещений medinaos.com используется Vercel Web Analytics.
          Передаются только просмотры известных разделов без параметров ссылок
          и фрагментов адреса. Имена, телефоны, содержимое заявок, идентификаторы
          клиентов и сотрудников в аналитику не передаются. События с небезопасным
          адресом источника перехода отбрасываются. Статистика посещений не является
          учётом продуктивности сотрудников. Провайдер обрабатывает технические
          сведения запроса для агрегированной статистики. Эта интеграция не
          включает аналитику на тестовых развёртываниях или прежнем Vercel-адресе.
        </p>
      </Section>

      <Section title="4. Реклама и Meta/Facebook/Instagram">
        <p style={P}>
          Если организация подключает Meta/Facebook/Instagram Ads, Medina OS может использовать идентификаторы рекламного аккаунта, страницы, кампаний, групп объявлений, объявлений и креативов для создания, проверки, остановки или анализа рекламы. Рекламные бюджеты оплачиваются через Meta аккаунт клиента и не включаются в оплату Medina OS.
        </p>
      </Section>

      <Section title="5. Секретные ключи и токены">
        <p style={P}>
          Серверные секреты интеграций, service role keys, серверные токены интеграций и app secrets используются на серверной стороне. Они не показываются обычным пользователям в интерфейсе Medina OS. В интерфейсе могут отображаться безопасные технические признаки, например факт наличия ключа или публичные идентификаторы аккаунтов. Пользовательские сеансы авторизации отдельно обрабатываются браузером.
        </p>
      </Section>

      <Section title="6. Хранение и защита данных">
        <p style={P}>
          Мы принимаем разумные технические меры для защиты данных от несанкционированного доступа, изменения или удаления. Доступ к рабочему пространству ограничивается ролями сотрудников и настройками организации.
        </p>
        <p style={P}>
          Браузерное хранилище localStorage и sessionStorage используется для необходимых данных авторизации, выбора рабочего пространства, настроек интерфейса и, в отдельных модулях, черновиков. Это хранение отличается от статистики посещений.
        </p>
        <p style={P}>
          Объём и срок хранения зависят от цели обработки, используемой функции и применимых требований закона; основания дальнейшего хранения требуют проверки при рассмотрении запроса. CRM и AI-контент не принимают банковских решений, не одобряют ипотеку и не заменяют медицинскую диагностику.
        </p>
      </Section>

      <Section title="7. Удаление данных">
        <p style={P}>
          Пользователь или уполномоченный представитель организации может запросить удаление своих данных или отзыв согласия, если обработка основана на нём, по email:{' '}
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
      <div className="public-legal-page" style={{ minHeight: '100vh', background: '#F4F7FB', padding: '40px 16px 60px', fontFamily: "'Inter', sans-serif" }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>

          {/* Logo + back */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
            <Link href="/" style={{ textDecoration: 'none' }}>
              <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: '0.15em', color: '#0B1220' }}>Medina OS</span>
            </Link>
            <Link href="/" style={{ color: '#64748B', fontSize: 14, textDecoration: 'none' }}>
              На главную
            </Link>
          </div>

          {/* Card */}
          <div className="public-legal-panel" style={{
            background: '#FFFFFF', borderRadius: 20,
            boxShadow: '6px 6px 16px #C8CDD4, -6px -6px 16px #FFFFFF',
          }}>
            <h1 className="public-legal-title" style={{ fontWeight: 700, color: '#0B1220', margin: '0 0 8px' }}>{heading}</h1>
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
              <span style={{ color: '#B0BAC6', fontSize: 13 }}>© 2026 Medina OS</span>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
