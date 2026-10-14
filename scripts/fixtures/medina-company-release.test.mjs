import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';

const require = createRequire(import.meta.url);
const { buildCompanyRelease } = require('../build-medina-company-release.cjs');
const sourceUrl = new URL('../../docs/previews/medina-company/index.html', import.meta.url);
const allowedEntries = {
  dist: 'directory',
  'dist/index.html': 'file',
  'dist/robots.txt': 'file',
  'dist/404.html': 'file',
  'dist/_headers': 'file',
};
const securityHeaders = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cache-Control': 'public, max-age=0, must-revalidate',
};
const cspDirectives = {
  'default-src': ["'none'"],
  'script-src': ["'none'"],
  'connect-src': ["'none'"],
  'style-src': ["'unsafe-inline'"],
  'img-src': ['data:'],
  'font-src': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
};
let release, sourcePage, indexPage, notFoundPage, robots, headerText;

// Buildless source contracts only, not native hosting response or routing checks.
before(() => {
  sourcePage = readFileSync(sourceUrl);
  release = buildCompanyRelease();
  const output = path.join(release.directory, 'dist');
  indexPage = readFileSync(path.join(output, 'index.html'));
  notFoundPage = readFileSync(path.join(output, '404.html'));
  robots = readFileSync(path.join(output, 'robots.txt'), 'utf8');
  headerText = readFileSync(path.join(output, '_headers'), 'utf8');
});

function packageInventory(directory, prefix = '') {
  const entries = {};
  for (const name of readdirSync(directory)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const absolute = path.join(directory, name);
    const stat = lstatSync(absolute);
    assert.equal(stat.isSymbolicLink(), false, `no symlink or junction: ${relative}`);
    assert.ok(Object.hasOwn(allowedEntries, relative), `unallowlisted package entry: ${relative}`);
    const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special';
    assert.equal(kind, allowedEntries[relative], `entry type: ${relative}`);
    entries[relative] = kind;
    if (kind === 'directory') Object.assign(entries, packageInventory(absolute, relative));
  }
  return entries;
}

test('source contract: exact buildless inventory excludes symlinks, API, functions, env, code and site identity', () => {
  const stat = lstatSync(release.directory);
  assert.equal(stat.isSymbolicLink(), false, 'package root must not be a symlink or junction');
  assert.equal(stat.isDirectory(), true);
  assert.deepEqual(packageInventory(release.directory), allowedEntries);
  assert.deepEqual(release.staticFiles, ['index.html', 'robots.txt', '404.html', '_headers']);
});

test('source contract: default build returns only directory, SHA256 and staticFiles in a fresh temp directory', () => {
  assert.deepEqual(Object.keys(release).sort(), ['directory', 'sha256', 'staticFiles']);
  assert.equal(path.isAbsolute(release.directory), true);
  assert.equal(path.dirname(release.directory), path.resolve(tmpdir()));
  assert.match(path.basename(release.directory), /^medina-company-release-.+/);
});

test('source contract: index bytes and reported SHA256 equal the prepared company source', () => {
  assert.ok(indexPage.equals(sourcePage), 'dist/index.html must be a byte-for-byte copy');
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.match(release.sha256, /^[a-f0-9]{64}$/);
  assert.equal(release.sha256, sha256(sourcePage));
  assert.equal(sha256(indexPage), release.sha256);
});

test('source contract: index and 404 stay noindex and only the approved Meta crawler can read the site', () => {
  for (const page of [indexPage, notFoundPage]) {
    assert.match(page.toString('utf8'), /<meta\s+name="robots"\s+content="noindex, nofollow, noarchive"\s*\/?>/i);
  }
  assert.equal(robots, 'User-agent: facebookexternalhit\nAllow: /\n\nUser-agent: *\nDisallow: /\n');
});

test('source contract: global _headers declares CSP, noindex and security response headers', () => {
  const lines = headerText.split(/\r?\n/);
  assert.equal(lines.shift(), '/*', 'one global header rule, not a route or rewrite');
  const headers = {};
  const names = new Set();
  for (const line of lines.filter(line => line.trim())) {
    const match = line.match(/^ {2}([A-Za-z][A-Za-z0-9-]*): (.+)$/);
    assert.ok(match, 'only indented header declarations may follow the global rule');
    const [, name, value] = match;
    assert.ok(!names.has(name.toLowerCase()), `duplicate header: ${name}`);
    names.add(name.toLowerCase());
    headers[name] = value;
  }
  const { 'Content-Security-Policy': policy, ...otherHeaders } = headers;
  assert.deepEqual(otherHeaders, securityHeaders);
  assert.equal(typeof policy, 'string');
  const directives = {};
  for (const part of policy.split(';').filter(part => part.trim())) {
    const [name, ...sources] = part.trim().split(/\s+/);
    assert.ok(!Object.hasOwn(directives, name), `duplicate CSP directive: ${name}`);
    directives[name] = sources;
  }
  assert.deepEqual(directives, cspDirectives);
  assert.deepEqual(directives['frame-src'] ?? directives['child-src'] ?? directives['default-src'], ["'none'"]);
});

test('source contract: 404.html is an honest standalone not-found document, not an SPA copy or redirect', () => {
  assert.equal(notFoundPage.equals(indexPage), false, '404 must not reuse the company index');
  const html = new TextDecoder('utf-8', { fatal: true }).decode(notFoundPage);
  const notFoundLabel = '\u0421\u0442\u0440\u0430\u043d\u0438\u0446\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430';
  assert.match(html, /^\s*<!doctype html>/i);
  assert.match(html, /<html\b[^>]*\blang="ru"/i);
  const titles = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)];
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)];
  assert.deepEqual(titles.map(match => match[1].trim()), [`${notFoundLabel} | Medina OS`]);
  assert.deepEqual(headings.map(match => match[1].trim()), [notFoundLabel]);
  assert.match(html, /<a\s+href="\/">Medina OS<\/a>/);
  assert.doesNotMatch(html, /<\s*(?:script|form|iframe|frame|object|embed|base)\b|\bon[a-z]+\s*=|\b(?:javascript|https?|wss?):|http-equiv\s*=\s*["']refresh["']/i);
});

test('source contract: an explicit destination must be absolute', () => {
  for (const destination of ['.', 'company-release', '../company-release']) {
    assert.throws(() => buildCompanyRelease(destination), { message: 'Absolute destination required' });
  }
});

test('source contract: a nonempty absolute destination is refused without changing existing files', () => {
  const originalFiles = release.staticFiles.map(name => {
    const filename = path.join(release.directory, 'dist', name);
    return [filename, readFileSync(filename)];
  });
  assert.throws(() => buildCompanyRelease(release.directory), { message: 'Destination must be empty' });
  assert.deepEqual(packageInventory(release.directory), allowedEntries);
  for (const [filename, bytes] of originalFiles) {
    assert.ok(readFileSync(filename).equals(bytes), 'refused build must preserve every existing file');
  }
});
