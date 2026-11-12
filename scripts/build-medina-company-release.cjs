const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'docs/previews/medina-company/index.html');
const policy = "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const headers = {
  'Content-Security-Policy': policy,
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cache-Control': 'public, max-age=0, must-revalidate',
};

function buildCompanyRelease(destination) {
  if (destination !== undefined && !path.isAbsolute(destination)) throw new Error('Absolute destination required');
  const directory = destination === undefined
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'medina-company-release-'))
    : path.resolve(destination);
  if (fs.existsSync(directory) && fs.readdirSync(directory).length !== 0) throw new Error('Destination must be empty');

  // Copy only approved static assets; no CRM, API, environment files or secrets.
  const staticDirectory = path.join(directory, 'dist');
  fs.mkdirSync(staticDirectory, { recursive: true });
  const page = fs.readFileSync(source);
  fs.writeFileSync(path.join(staticDirectory, 'index.html'), page);
  fs.writeFileSync(path.join(staticDirectory, 'robots.txt'), 'User-agent: facebookexternalhit\nAllow: /\n\nUser-agent: *\nDisallow: /\n');
  fs.writeFileSync(path.join(staticDirectory, '_headers'), '/*\n'
    + Object.entries(headers).map(([name, value]) => `  ${name}: ${value}\n`).join(''));
  fs.writeFileSync(path.join(staticDirectory, '404.html'), '<!doctype html>\n<html lang="ru"><head>'
    + '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex, nofollow, noarchive">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'">'
    + '<title>Страница не найдена | Medina OS</title></head>'
    + '<body><h1>Страница не найдена</h1><p><a href="/">Medina OS</a></p></body></html>\n');
  return { directory, sha256: createHash('sha256').update(page).digest('hex'), staticFiles: ['index.html', 'robots.txt', '404.html', '_headers'] };
}

if (require.main === module) process.stdout.write(JSON.stringify(buildCompanyRelease(process.argv[2]), null, 2) + '\n');
module.exports = { buildCompanyRelease };
