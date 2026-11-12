import { Link } from "wouter";
import "./legal.css";

export default function DataDeletion() {
  return (
    <LegalPage title="Удаление данных пользователя — Medina OS" heading="Удаление данных пользователя" updated="24 октября 2026">

      <p style={P}>
        Запрос на удаление своих данных из Medina OS или отзыв согласия, если обработка основана на нём, можно направить по email:{' '}
        <a href="mailto:kipshakoveldar4@gmail.com" style={A}>kipshakoveldar4@gmail.com</a>
      </p>

      <Section title="В письме укажите">
        <ul style={UL}>
          <li style={LI}>минимальные сведения для поиска своей записи: использованное в сервисе имя или контакт и способ обратной связи;</li>
          <li style={LI}>название организации или рабочего пространства, если известно;</li>
          <li style={LI}>какие ваши данные и какой запрос требуется рассмотреть; источник обращения, если известен.</li>
        </ul>
        <p style={P}>
          Не отправляйте документы, удостоверяющие личность, пароли, коды входа или токены доступа. Проверка принадлежности запроса и полномочий должна ограничиваться необходимыми для этого сведениями.
        </p>
      </Section>

      <Section title="Рассмотрение запроса">
        <p style={P}>
          Запрос рассматривается с проверкой его принадлежности и полномочий заявителя. При рассмотрении запроса и выполнении необходимых действий применяются установленные законом сроки. Допустимый объём действий определяется после проверки цели обработки, применимых требований закона и оснований дальнейшего хранения. Это не означает автоматического удаления всех связанных данных.
        </p>
      </Section>

      <Section title="Инструмент удаления заявки с сайта">
        <p style={P}>
          Внутренний инструмент CRM, если он включён для сайта и доступен уполномоченному владельцу или администратору, предназначен только для выбранной заявки с сайта и её копий согласия. При связях с рабочими данными удаление может быть заблокировано до отдельного разбора. Это не замена рассмотрению запроса по email.
        </p>
        <p style={P}>
          Инструмент не очищает другие обращения, данные внешних провайдеров или резервные копии; их обработка требует отдельной проверки. Запрос не даёт права удалять данные других клиентов или рабочих пространств.
        </p>
      </Section>

      <Section title="Данные из Facebook / Instagram Lead Ads">
        <p style={P}>
          Если ваши данные были получены через Facebook или Instagram Lead Ads, укажите этот источник, если он известен. Допустимый объём удаления определяется после проверки принадлежности запроса, ваших прав и оснований хранения. Запрос не означает удаления всех рекламных данных аккаунта или данных других клиентов; данные у Meta требуют отдельного рассмотрения.
        </p>
      </Section>

      <Section title="Запрос на английском" last>
        <div style={{
          background: '#F8FAFC', border: '1px solid #E7ECF3', borderRadius: 12,
          padding: '16px 20px', fontSize: 14, color: '#475569', lineHeight: 1.7,
        }}>
          To request deletion of your data from Medina OS, please email{' '}
          <a href="mailto:kipshakoveldar4@gmail.com" style={A}>kipshakoveldar4@gmail.com</a>{' '}
          with only the name or contact already used in the service, a reply contact, the organization or workspace if known, and the scope of your request. Do not send identity documents, passwords, login codes or access tokens. A consent withdrawal request may also be submitted where processing relies on consent. Requests are reviewed with verification of ownership and the requester's authority. Applicable statutory deadlines govern request handling and any required action. The lawful scope of action is determined after reviewing the processing purpose, applicable law and grounds for further retention. This does not promise automatic deletion of all related data. The enabled in-CRM site-inquiry tool is limited to one selected inquiry and its consent copies, may be blocked by linked records, and does not replace email request handling. Other inquiries, external providers and backups require separate review. A request does not authorize erasure of other clients or workspaces, or automatic deletion of all Facebook/Instagram advertising data.
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
      <div className="public-legal-page" style={{ minHeight: '100vh', background: '#F4F7FB', padding: '40px 16px 60px', fontFamily: "'Inter', sans-serif" }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
            <Link href="/" style={{ textDecoration: 'none' }}>
              <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: '0.15em', color: '#0B1220' }}>Medina OS</span>
            </Link>
            <Link href="/" style={{ color: '#64748B', fontSize: 14, textDecoration: 'none' }}>
              На главную
            </Link>
          </div>

          <div className="public-legal-panel" style={{
            background: '#FFFFFF', borderRadius: 20,
            boxShadow: '6px 6px 16px #C8CDD4, -6px -6px 16px #FFFFFF',
          }}>
            <h1 className="public-legal-title" style={{ fontWeight: 700, color: '#0B1220', margin: '0 0 8px' }}>{heading}</h1>
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
              <span style={{ color: '#B0BAC6', fontSize: 13 }}>© 2026 Medina OS</span>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
