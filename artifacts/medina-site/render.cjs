const { services, audiences, articles: previewArticles, crmOrigin } = require('./content.cjs');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
const e = escapeHtml;
const articleTags = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'br']);
function renderArticleNodes(nodes) {
  return nodes.map(node => {
    if (typeof node === 'string') return e(node);
    if (!articleTags.has(node.tag)) throw new Error('Unsupported article element');
    if (node.tag === 'br') return '<br>';
    const attrs = node.tag === 'a' && node.href ? ` href="${e(node.href)}" rel="noopener noreferrer"`
      : node.tag === 'ol' && Number.isSafeInteger(node.start) && node.start > 0 ? ` start="${node.start}"` : '';
    return `<${node.tag}${attrs}>${renderArticleNodes(node.children)}</${node.tag}>`;
  }).join('');
}
function articleBody(item) {
  if (item.nodes) return `<div class="article-body">${renderArticleNodes(item.nodes)}</div>`;
  return typeof item.body === 'string' ? item.body.split(/\n\s*\n/).map(text => `<p class="article-text">${e(text)}</p>`).join('')
    : item.sections.map(([heading, text]) => `<section><h2>${e(heading)}</h2><p>${e(text)}</p></section>`).join('');
}
function publicationDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
const serviceUrl = item => `/ru/services/${item.slug}/`;
const articleUrl = item => `/ru/blog/${item.slug}/`;
const audienceUrl = item => `/ru/solutions/${item.slug}/`;
const action = '<a class="button primary" href="/ru/#consultation">Оставить заявку <span aria-hidden="true">↗</span></a>';

function baseLayout({ title, description, content, section = '', intake = null, preview = true, indexable = false, assetBase = '', article = false, origin }) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${e(title)} | Medina OS</title><meta name="description" content="${e(description)}"><meta name="robots" content="${indexable ? 'index,follow' : 'noindex,nofollow'}">
  <meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(description)}"><meta property="og:type" content="${article ? 'article' : 'website'}"><meta property="og:locale" content="ru_RU"><meta property="og:site_name" content="Medina OS">${origin ? `<meta property="og:image" content="${e(origin + assetBase + '/assets/brand.png')}"><meta property="og:image:alt" content="Medina OS">` : ''}
  <meta name="referrer" content="strict-origin-when-cross-origin"><link rel="icon" href="${assetBase}/assets/brand.png"><link rel="stylesheet" href="${assetBase}/site.css">${intake ? `<script src="${assetBase}/form.js" defer></script>` : ''}</head>
  <body><a class="skip" href="#main">К содержимому</a>
  ${preview ? '<div class="preview">Предпросмотр сайта Medina OS</div>' : ''}
  <header class="shell header"><a class="brand" href="/ru/" aria-label="Medina OS — главная"><img src="${assetBase}/assets/brand.png" width="32" height="32" alt="">Medina OS</a>
  <nav aria-label="Основная навигация"><a href="/ru/#audiences" ${section === 'audiences' ? 'aria-current="page"' : ''}>Для кого</a><a href="/ru/#services" ${section === 'services' ? 'aria-current="page"' : ''}>Услуги</a><a href="/ru/blog/" ${section === 'blog' ? 'aria-current="page"' : ''}>Блог</a><a href="${crmOrigin}/login">Войти в CRM</a></nav></header>
  <main id="main">${content}</main>
  <footer><div class="shell footer"><a class="brand" href="/ru/">Medina OS</a><p>Маркетинг, обращения и работа с клиентами.</p><a href="${crmOrigin}/privacy">Конфиденциальность</a><a href="${crmOrigin}/terms">Условия</a></div></footer></body></html>`;
}

function serviceList() {
  return `<div class="service-list">${services.map(item => `<a class="service" href="${serviceUrl(item)}"><span class="number">${item.number}</span><div><h3>${e(item.title)}</h3><p>${e(item.short)}</p></div><span class="arrow" aria-hidden="true">↗</span></a>`).join('')}</div>`;
}

function audienceList() {
  return `<div class="audience-list">${audiences.map(item => `<a href="${audienceUrl(item)}"><h3>${e(item.label)}</h3><p>${e(item.summary)}</p><span class="text-link">Подробнее →</span></a>`).join('')}</div>`;
}

function breadcrumbs(label) {
  return `<nav class="shell breadcrumbs" aria-label="Хлебные крошки"><ol><li><a href="/ru/">Medina OS</a></li><li><a href="/ru/#audiences">Для кого</a></li><li><span aria-current="page">${e(label)}</span></li></ol></nav>`;
}

function articleBreadcrumbs(item) {
  // Microdata is readable without JavaScript and preserves the strict CSP.
  return `<nav class="shell breadcrumbs" aria-label="Хлебные крошки" itemscope itemtype="https://schema.org/BreadcrumbList"><ol>${[
    ['Medina OS', '/ru/'], ['Блог', '/ru/blog/'], [item.title, articleUrl(item)],
  ].map(([label, url], index) => `<li itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem"><a itemprop="item" href="${e(url)}"${index === 2 ? ' aria-current="page"' : ''}><span itemprop="name">${e(label)}</span></a><meta itemprop="position" content="${index + 1}"></li>`).join('')}</ol></nav>`;
}

function publishedArticle(item, articles, options) {
  const date = options.preview === false ? publicationDate(item.publishedAt) : null;
  const related = articles.filter(other => other.slug !== item.slug).slice(0, 3);
  return `${articleBreadcrumbs(item)}<article class="shell narrow article" itemscope itemtype="https://schema.org/BlogPosting"><meta itemprop="inLanguage" content="ru"><meta itemprop="headline" content="${e(item.title)}">${options.origin ? `<link itemprop="mainEntityOfPage" href="${e(options.origin + articleUrl(item))}">` : ''}<header><p class="eyebrow">${e(item.category || 'Блог Medina OS')}</p><h1>${e(item.title)}</h1><p class="lead" itemprop="description">${e(item.summary)}</p><p class="article-meta">Материал <span itemprop="author" itemscope itemtype="https://schema.org/Organization"><a href="/ru/" itemprop="url"><span itemprop="name">Medina OS</span></a></span>${date ? ` · Редакция опубликована <time itemprop="dateModified" datetime="${e(date)}">${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(date))}</time>` : ''}</p>${options.preview === false ? '' : '<p class="draft">Редакционный черновик · ожидает проверки перед публикацией</p>'}</header><div itemprop="articleBody">${articleBody(item)}</div><aside class="article-cta"><h2>Обсудим вашу задачу?</h2><p>Начните с направления, которое сейчас требует внимания команды.</p><a class="button primary" href="/ru/#consultation">Оставить заявку ↗</a></aside></article>${related.length ? `<section class="reading band"><div class="shell"><h2>Читайте также</h2>${renderArticleCards(related)}</div></section>` : ''}`;
}

function renderArticleCards(articles) {
  if (!articles.length) return '<p>Материалы готовятся к публикации.</p>';
  return `<div class="articles">${articles.map(item => `<article><p class="eyebrow">${e(item.category || 'Блог Medina OS')}</p><h3><a href="${articleUrl(item)}">${e(item.title)}</a></h3><p>${e(item.summary)}</p><a class="text-link" href="${articleUrl(item)}">Читать статью <span aria-hidden="true">↗</span></a></article>`).join('')}</div>`;
}

function consultation(intake) {
  return `<section id="consultation" class="consultation band"><div class="shell consultation-grid"><div><p class="eyebrow">Начнём с вашей задачи</p><h2>Оставить заявку</h2><p>Привлечение новых клиентов, обработка обращений или оба направления вместе.</p><p class="notice" id="form-status" role="status" aria-live="polite">${intake ? 'Оставьте контакты для обратной связи. Не указывайте медицинские сведения.' : 'Приём заявок ещё не подключён. Данные из этого предпросмотра никуда не отправляются.'}</p></div>
  <form method="post" aria-describedby="form-status" ${intake ? `data-intake-endpoint="${e(intake.endpoint)}" data-site-key="${e(intake.siteKey)}" data-consent-version="${e(intake.consentVersion)}"` : ''}><fieldset ${intake ? '' : 'disabled'}><legend class="sr-only">Заявка на консультацию</legend>
  <label>Ваше имя<input name="name" required maxlength="100" autocomplete="off" placeholder="Как к вам обращаться"></label>
  <label>Телефон<input name="phone" type="tel" required maxlength="40" autocomplete="off" placeholder="+7"></label>
  <label>Название бизнеса<input name="business" required maxlength="160" autocomplete="off" placeholder="Клиника, стоматология или салон"></label>
  <label>Что вас интересует<select name="service" required><option value="">Выберите направление</option>${services.map(item => `<option value="${item.slug}">${e(item.title)}</option>`).join('')}</select></label>
  ${intake ? `<label class="consent"><input type="checkbox" name="consent" required><span>Согласен на обработку имени, телефона и сведений об организации для обратной связи согласно <a href="${crmOrigin}/privacy" target="_blank" rel="noopener noreferrer">политике конфиденциальности</a>.</span></label><div data-challenge></div>` : ''}
  <button class="button primary" type="${intake ? 'submit' : 'button'}" disabled>Оставить заявку</button></fieldset></form></div></section>`;
}

function createPages(intake = null, options = {}) {
  const articles = options.articles ?? (options.preview === false ? [] : previewArticles);
  const articleCards = () => renderArticleCards(articles);
  const layout = input => baseLayout({ ...options, ...input });
  const pages = new Map();
  pages.set('/ru/', layout({ intake, title: 'Маркетинг для клиник и салонов', description: 'Medina OS: реклама, обработка обращений и CRM для клиник, стоматологий и салонов.', content: `
    <section class="intro"><div class="shell"><p class="eyebrow">Для клиник · стоматологий · салонов</p><h1>Medina OS</h1><p class="intro-text">Реклама привлекает внимание.<br>Команда превращает его в запись.</p><p class="intro-note">Соединяем маркетинг, работу оператора и CRM, чтобы каждое обращение получало следующий шаг.</p>${action}<a class="secondary-link" href="#services">Выбрать услугу ↓</a></div></section>
    <section class="band shell" id="audiences"><div class="section-heading"><p class="eyebrow">Для вашего бизнеса</p><h2>Разные услуги.<br>Понятный путь до записи.</h2></div>${audienceList()}</section>
    <section class="band shell" id="services"><div class="section-heading"><p class="eyebrow">Чем поможем</p><h2>От первого интереса<br>до разговора с клиентом</h2></div>${serviceList()}</section>
    <section class="process band"><div class="shell"><p class="eyebrow">Один связанный процесс</p><h2>Заявка не должна теряться<br>после рекламы</h2><ol class="steps"><li><span>01 / Привлечение</span><h3>Понятное предложение</h3><p>Услуга, город и креатив, согласованные с вашей командой.</p></li><li><span>02 / Обращение</span><h3>Контекст в CRM</h3><p>Запрос клиента и ответственный за следующий контакт.</p></li><li><span>03 / Запись</span><h3>Работа оператора</h3><p>Услуги из прайса и время специалиста, а не обещание наугад.</p></li></ol></div></section>
    <section class="band shell"><div class="section-heading"><p class="eyebrow">Без завышенных обещаний</p><h2>Понятно, что согласовано.<br>Видно, что произошло.</h2></div><div class="principles"><p><strong>Бюджет под контролем.</strong> Создание кампании не означает автоматического включения рекламы.</p><p><strong>Факты отдельно от ожиданий.</strong> Расходы, обращения и оплаченные продажи не подменяют друг друга.</p><p><strong>Условия до начала работы.</strong> Объём услуг, обязанности оператора и оплата согласуются отдельно.</p></div></section>
    <section class="reading band"><div class="shell"><div class="section-heading"><p class="eyebrow">Блог Medina OS</p><h2>Разобраться в главном</h2></div>${articleCards()}</div></section>${consultation(intake)}` }));
  for (const item of services) pages.set(serviceUrl(item), layout({ title: item.title, description: item.short, section: 'services', content: `
    <div class="shell"><a class="back" href="/ru/#services">← Все услуги</a></div><section class="detail-head shell"><p class="eyebrow">Medina OS / Услуги</p><h1>${e(item.title)}</h1><p class="lead">${e(item.intro)}</p>${action}</section>
    <section class="band shell narrow"><h2>Как строится работа</h2><ol class="deliverables">${item.steps.map(step => `<li>${e(step)}</li>`).join('')}</ol><aside class="notice"><strong>Важно до начала работы</strong><p>${e(item.boundary)}</p></aside><h2>${e(item.question)}</h2><p>${e(item.answer)}</p></section><section class="reading band"><div class="shell"><h2>Полезно перед разговором</h2>${articleCards()}</div></section>` }));
  for (const item of audiences) pages.set(audienceUrl(item), layout({ title: item.title, description: item.summary, section: 'audiences', content: `
    ${breadcrumbs(item.label)}<section class="detail-head shell"><p class="eyebrow">${e(item.label)} / Medina OS</p><h1>${e(item.title)}</h1><p class="lead">${e(item.intro)}</p>${action}</section>
    <div class="shell narrow solution-topics">${item.topics.map(([heading, text]) => `<section><h2>${e(heading)}</h2><p>${e(text)}</p></section>`).join('')}</div>
    <section class="band reading"><div class="shell narrow"><h2>Перед подключением</h2>${item.questions.map(([question, answer]) => `<section class="solution-question"><h3>${e(question)}</h3><p>${e(answer)}</p></section>`).join('')}</div></section>
    <section class="band shell narrow"><h2>С чего начать</h2><ul class="related-services">${item.serviceSlugs.map(slug => { const service = services.find(entry => entry.slug === slug); return `<li><a class="text-link" href="${serviceUrl(service)}">${e(service.title)}</a><p>${e(service.short)}</p></li>`; }).join('')}</ul><p><a class="text-link" href="/ru/blog/">Материалы о рекламе и работе с заявками →</a></p>${action}</section>` }));
  pages.set('/ru/blog/', layout({ title: 'Блог о рекламе и обработке заявок', description: 'Материалы Medina OS о подготовке рекламы, работе с обращениями и CRM.', section: 'blog', content: `<section class="detail-head shell"><p class="eyebrow">Блог Medina OS</p><h1>Блог о рекламе и работе с заявками</h1><p class="lead">О рекламе, заявках и работе команды простыми словами.</p></section><section class="shell band">${articleCards()}</section>` }));
  for (const item of articles) pages.set(articleUrl(item), layout({ title: item.title, description: item.summary, section: 'blog', article: true, content: publishedArticle(item, articles, options) }));
  pages.set('/404.html', layout({ title: 'Страница не найдена', description: 'Этой страницы нет на сайте Medina OS.', content: '<section class="shell detail-head"><p class="eyebrow">404</p><h1>Здесь пока ничего нет</h1><p class="lead">Вернитесь на главную или выберите материал в блоге.</p><a class="button primary" href="/ru/">На главную</a></section>' }));
  if (options.origin) {
    const origin = new URL(options.origin);
    if (origin.protocol !== 'https:' || origin.origin !== options.origin) throw new Error('Invalid site origin');
    for (const [url, html] of pages) {
      if (url === '/404.html') continue;
      const canonical = e(origin.origin + url);
      pages.set(url, html.replace('</head>', `<link rel="canonical" href="${canonical}"><meta property="og:url" content="${canonical}"></head>`));
    }
  }
  pages.set('/404.html', pages.get('/404.html').replace('content="index,follow"', 'content="noindex,nofollow"'));
  return pages;
}

function createSitemap(pages, origin, articles = []) {
  if (new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) throw new Error('Invalid site origin');
  const dates = new Map(articles.map(item => [articleUrl(item), publicationDate(item.publishedAt)]));
  return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    + [...pages.keys()].filter(url => url.startsWith('/ru/')).map(url => `<url><loc>${e(origin + url)}</loc>${dates.get(url) ? `<lastmod>${e(dates.get(url))}</lastmod>` : ''}</url>`).join('') + '</urlset>';
}

module.exports = { escapeHtml, createPages, createSitemap, renderArticleNodes };
