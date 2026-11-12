import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pageUrl = new URL('../../docs/previews/medina-company/index.html', import.meta.url);
const iconUrl = new URL('../../../artifacts/negis/public/icon-192.png', pageUrl);
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
let html, head, body, tags;

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(?:#(x[\da-f]+|\d+);?|(?:(amp|lt|gt|quot|apos|nbsp);))/gi, (match, number, name) => {
    if (name) return named[name.toLowerCase()];
    const code = number.toLowerCase().startsWith('x') ? parseInt(number.slice(1), 16) : Number(number);
    assert.ok(code > 0 && code <= 0x10ffff, 'invalid numeric HTML entity');
    return String.fromCodePoint(code);
  });
}

// A narrow static-page tokenizer, not a browser DOM or computed-style check.
function elements(source) {
  return [...source.matchAll(/<\/?([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)].map(match => {
    const attrs = Object.create(null);
    const closing = match[0].startsWith('</');
    if (!closing) {
      for (const attr of match[2].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        const name = attr[1].toLowerCase();
        assert.ok(!Object.hasOwn(attrs, name), `duplicate ${name} attribute`);
        attrs[name] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? '');
      }
    }
    return { name: match[1].toLowerCase(), attrs, closing, index: match.index, end: match.index + match[0].length };
  });
}

function textContent(source) {
  return decodeEntities(source.replace(/<[^>]*>/g, ' ')).replace(/\s+/gu, ' ').trim();
}

function bodyText() {
  const stack = [];
  const chunks = [];
  let cursor = 0;
  const isHidden = node => ['style', 'script', 'template'].includes(node.name)
    || Object.hasOwn(node.attrs, 'hidden') || node.attrs['aria-hidden']?.toLowerCase() === 'true'
    || /(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\s|;|$))/i.test(node.attrs.style ?? '');
  for (const node of elements(body)) {
    if (!stack.some(isHidden)) chunks.push(body.slice(cursor, node.index));
    if (node.closing) {
      const index = stack.findLastIndex(open => open.name === node.name);
      if (index !== -1) stack.splice(index);
    } else if (!voidTags.has(node.name)) {
      stack.push(node);
    }
    cursor = node.end;
  }
  if (!stack.some(isHidden)) chunks.push(body.slice(cursor));
  return textContent(chunks.join(' '));
}

function meta(attribute, value) {
  const found = elements(head).filter(node => !node.closing && node.name === 'meta'
    && node.attrs[attribute]?.toLowerCase() === value);
  assert.equal(found.length, 1, `exactly one head meta ${attribute}=${value}`);
  return found[0];
}

before(() => {
  html = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(pageUrl)).replace(/<!--[\s\S]*?-->/g, '');
  head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1] ?? '';
  body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? '';
  tags = elements(html).filter(node => !node.closing);
});

test('one Russian UTF-8 document stays under docs, outside runtime and public output', () => {
  assert.equal(path.relative(root, fileURLToPath(pageUrl)).split(path.sep).join('/'), 'docs/previews/medina-company/index.html');
  assert.match(html, /^\s*<!doctype html>/i);
  for (const name of ['html', 'head', 'body']) {
    assert.equal(tags.filter(node => node.name === name).length, 1, `one ${name} element`);
    assert.equal([...html.matchAll(new RegExp(`</${name}\\s*>`, 'gi'))].length, 1, `one closing ${name}`);
  }
  assert.equal(tags.find(node => node.name === 'html').attrs.lang, 'ru');
  assert.equal(meta('charset', 'utf-8').attrs.charset.toLowerCase(), 'utf-8');
  const titles = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)];
  assert.equal(titles.length, 1);
  assert.equal(textContent(titles[0][1]), 'Medina OS | ИП КЫПШАКОВА ДИАНА КИЯСКЫЗЫ');
  const viewport = meta('name', 'viewport').attrs.content ?? '';
  assert.match(viewport, /(?:^|,)\s*width\s*=\s*device-width\s*(?:,|$)/i);
  assert.match(viewport, /(?:^|,)\s*initial-scale\s*=\s*1(?:\.0)?\s*(?:,|$)/i);
});

test('the approved Save group domain-verification tag is static and appears exactly once in head', () => {
  assert.equal(meta('name', 'facebook-domain-verification').attrs.content, 'zg4jvzzo2t6arctcg0c3jo6ph0oatn');
  assert.equal(tags.filter(node => node.name === 'meta' && node.attrs.name === 'facebook-domain-verification').length, 1);
  assert.doesNotMatch(body, /facebook-domain-verification/i);
});

test('robots and early CSP keep the standalone company page closed to indexing and active content', () => {
  assert.deepEqual(new Set(meta('name', 'robots').attrs.content?.toLowerCase().split(/[\s,]+/).filter(Boolean)),
    new Set(['noindex', 'nofollow', 'noarchive']));
  const policy = meta('http-equiv', 'content-security-policy');
  const directives = new Map();
  for (const part of (policy.attrs.content ?? '').split(';').filter(part => part.trim())) {
    const [name, ...sources] = part.trim().split(/\s+/);
    const key = name.toLowerCase();
    assert.ok(!directives.has(key), `duplicate CSP directive ${key}`);
    directives.set(key, sources);
  }
  const required = {
    'default-src': ["'none'"], 'script-src': ["'none'"], 'connect-src': ["'none'"],
    'form-action': ["'none'"], 'base-uri': ["'none'"], 'object-src': ["'none'"],
    'img-src': ['data:'], 'style-src': ["'unsafe-inline'"],
  };
  for (const [name, sources] of Object.entries(required)) assert.deepEqual(directives.get(name), sources, name);
  for (const [name, sources] of directives) {
    if (!Object.hasOwn(required, name)) assert.deepEqual(sources, ["'none'"], `${name} must not open another channel`);
  }
  for (const node of elements(head).filter(node => ['style', 'link', 'img'].includes(node.name))) {
    assert.ok(policy.index < node.index, 'CSP must precede styles and assets');
  }
});

test('no active content, redirects, canonical or unapproved verification metadata', () => {
  const forbidden = new Set(['script', 'form', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'template', 'input', 'select', 'textarea']);
  for (const node of tags) {
    assert.ok(!forbidden.has(node.name), `forbidden element ${node.name}`);
    for (const name of Object.keys(node.attrs)) {
      assert.ok(!/^on/i.test(name), `event handler ${name} is not static`);
      assert.ok(!['srcdoc', 'action', 'formaction', 'ping', 'srcset', 'imagesrcset', 'poster', 'data', 'background', 'manifest', 'codebase', 'archive', 'xlink:href'].includes(name), `forbidden attribute ${name}`);
    }
    assert.ok(!(node.attrs.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'), 'no canonical URL');
    if (node.name === 'meta') {
      assert.notEqual(node.attrs['http-equiv']?.toLowerCase(), 'refresh', 'no redirect');
      if (node.attrs.name === 'facebook-domain-verification') {
        assert.deepEqual({ ...node.attrs }, { name: 'facebook-domain-verification', content: 'zg4jvzzo2t6arctcg0c3jo6ph0oatn' });
      } else {
        assert.doesNotMatch(`${node.attrs.name ?? ''} ${node.attrs.property ?? ''}`, /verif(?:ication|ied)|msvalidate|^\s*fb:/i);
      }
    }
    assert.notEqual(node.attrs.itemtype?.toLowerCase(), 'https://schema.org/organization', 'no structured company claims');
  }
  assert.doesNotMatch(html, /application\/ld\+json/i, 'no JSON-LD');
});

test('only embedded PNG assets, same-page navigation and one approved mailto are allowed', () => {
  const ids = new Set(tags.map(node => node.attrs.id).filter(Boolean));
  let mailtoCount = 0;
  for (const node of tags) {
    if (Object.hasOwn(node.attrs, 'src')) {
      assert.equal(node.name, 'img', 'only images may have src');
      assert.match(node.attrs.src, /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
    }
    if (Object.hasOwn(node.attrs, 'href')) {
      if (node.name === 'link') {
        assert.equal(node.attrs.rel?.toLowerCase(), 'icon', 'no stylesheet, prefetch or other linked asset');
        assert.match(node.attrs.href, /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
      } else {
        assert.equal(node.name, 'a');
        if (/^mailto:/i.test(node.attrs.href)) {
          assert.equal(node.attrs.href, 'mailto:Yelkipq@gmail.com', 'only the approved email, without query parameters');
          mailtoCount += 1;
        } else {
          assert.match(node.attrs.href, /^#[\w:.-]+$/);
          assert.ok(ids.has(node.attrs.href.slice(1)), `missing local anchor ${node.attrs.href}`);
        }
      }
    }
  }
  assert.ok(mailtoCount <= 1, 'at most one mailto link; it does not send email automatically');
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(match => match[1])
    .concat(tags.map(node => node.attrs.style ?? '')).join('\n');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /@import\b|url\s*\(|expression\s*\(|-moz-binding|behavior\s*:/i);
  assert.doesNotMatch(decodeEntities(html), /\b(?:https?|wss?|ftp):|\/\/[a-z0-9.-]+\.[a-z]{2,}|\b(?:tel|javascript):|\bmailto:(?!Yelkipq@gmail\.com(?=["'<>\s]|$))/iu, 'no external, unapproved contact or executable URL');
});

test('logo and favicon contain identical canonical base64 bytes from the repository PNG', () => {
  const logos = tags.filter(node => node.name === 'img');
  const favicons = elements(head).filter(node => !node.closing && node.name === 'link' && node.attrs.rel?.toLowerCase() === 'icon');
  assert.equal(logos.length, 1, 'one embedded logo');
  assert.equal(favicons.length, 1, 'one embedded favicon');
  assert.equal(favicons[0].attrs.type, 'image/png');
  assert.ok(logos[0].attrs.src === favicons[0].attrs.href, 'logo and favicon data URIs must be identical');
  const match = logos[0].attrs.src?.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  assert.ok(match, 'logo must be an inline PNG');
  const embedded = Buffer.from(match[1], 'base64');
  assert.ok(embedded.toString('base64') === match[1], 'base64 must be canonical, not a permissively decoded payload');
  const expected = readFileSync(iconUrl);
  assert.equal(embedded.compare(expected), 0, 'embedded bytes must equal artifacts/negis/public/icon-192.png');
  assert.deepEqual([...expected.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(expected.toString('ascii', 12, 16), 'IHDR');
  assert.equal(expected.readUInt32BE(16), 192);
  assert.equal(expected.readUInt32BE(20), 192);
});

test('the approved email is visible only in contacts and no other email is allowed', () => {
  const nodes = elements(html);
  const contacts = nodes.filter(node => !node.closing && node.name === 'section' && node.attrs.id === 'contacts');
  assert.equal(contacts.length, 1, 'one contacts section');
  let depth = 0;
  let contactEnd;
  for (const node of nodes.filter(node => node.index >= contacts[0].index && node.name === 'section')) {
    depth += node.closing ? -1 : 1;
    if (depth === 0) {
      contactEnd = node;
      break;
    }
  }
  assert.ok(contactEnd, 'contacts section must close');
  const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/giu;
  const emails = [...decodeEntities(html).matchAll(emailPattern)].map(match => match[0]);
  assert.deepEqual(new Set(emails), new Set(['Yelkipq@gmail.com']), 'exact approved email allowlist');
  const outsideContacts = html.slice(0, contacts[0].index) + html.slice(contactEnd.end);
  assert.doesNotMatch(decodeEntities(outsideContacts), emailPattern, 'no email outside contacts, including hidden text and metadata');
  assert.ok(bodyText().includes('Yelkipq@gmail.com'), 'approved email must be in non-hidden body text');
});

test('body identifies only the approved company and location without draft notices or private data', () => {
  const headings = [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)];
  assert.equal(headings.length, 1);
  assert.equal(textContent(headings[0][1]), 'Medina OS');
  const text = bodyText();
  for (const required of ['ИП КЫПШАКОВА ДИАНА КИЯСКЫЗЫ', 'Medina OS', 'Казахстан', 'Актобе', 'medinaos.com']) {
    assert.ok(text.includes(required), `${required} must occur in non-hidden body text`);
  }
  assert.doesNotMatch(text, /Локальный черновик|Не опубликовано|ещё (?:не )?соглас/iu);
  for (const anchor of body.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    assert.doesNotMatch(textContent(anchor[1]), /\bmedinaos\.com\b/i, 'selected domain must be plain text, not a link');
  }
  const content = `${textContent(html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ''))} ${tags.flatMap(node => Object.entries(node.attrs)
    .filter(([, value]) => !value.startsWith('data:image/png;base64,'))
    .map(([, value]) => value)).join(' ')}`;
  assert.doesNotMatch(content, /\+\d(?:[\s().-]*\d){6,14}|(?:^|\D)[78](?:[\s().-]*\d){10}(?!\d)/u, 'no phone number');
  assert.doesNotMatch(content, /(?:^|\D)\d{12}(?!\d)|\bKZ\d{2}[A-Z0-9]{16}\b|(?:БИН|ИИН|БИК|IBAN)\s*[:№-]?\s*[A-Z\d]{6,}/iu, 'no fabricated legal or bank identifier');
  assert.doesNotMatch(content, /(?:улица|ул\.|проспект|пр-т|переулок|пер\.|микрорайон|мкр\.|улиц[аы]|көшесі)\s+[\p{L}\d][^<>\n]{0,100}\d|(?:дом|д\.|квартира|кв\.)\s*[:№-]?\s*\d/iu, 'no full street address or house number');
  assert.doesNotMatch(content, /(?:номер\s+(?:документа|удостоверения|паспорта)|(?:документ|удостоверение|паспорт)\s*№)\s*[:№-]?\s*[A-Z\d]{5,}|(?:скан|копия)\s+(?:документа|удостоверения|паспорта)|(?:банковский\s+сч[её]т|расч[её]тный\s+сч[её]т|номер\s+карты)\s*[:№-]?\s*[A-Z\d]{6,}/iu, 'no document number, identity scan or bank account data');
  assert.doesNotMatch(content, /\bMeta\s+Verified\b|(?:официальный|верифицированный|сертифицированный)\s+(?:партн[её]р\s+)?(?:Meta|Facebook)|(?:подтверждено|одобрено)\s+(?:Meta|Facebook)/iu, 'no affirmative Meta verification claims');
});
