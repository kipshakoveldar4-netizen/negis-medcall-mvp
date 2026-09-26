const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('visible app copy no longer uses the old product name', () => {
  const failures = [];
  function inspect(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { inspect(file); continue; }
      if (!/\.tsx?$/.test(file)) continue;
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isStringLiteral(node) || ts.isJsxText(node) || ts.isTemplateLiteralToken(node)) {
          const value = node.text;
          // This one legacy stored value must remain readable; it is never a label.
          if (!(file.endsWith('/negisApp.ts') && value === 'Negis App') && /\b(?:Negis|NEGIS)\b/.test(value)) {
            failures.push(file + ': ' + value.slice(0, 100));
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  inspect('artifacts/negis/src'); inspect('artifacts/medina-control/src');
  assert.deepEqual(failures, []);
});

test('static legal pages use Medina OS without changing contact email', () => {
  for (const name of ['privacy', 'terms', 'data-deletion']) {
    const html = read(`artifacts/negis/public/${name}/index.html`);
    assert.match(html, /Medina OS/);
    assert.doesNotMatch(html, /\bnegis\b/i);
    assert.match(html, /kipshakoveldar4@gmail\.com/);
  }
});

test('new creative filenames use Medina OS while existing supplied names are preserved', () => {
  const studio = read('artifacts/negis/src/pages/ContentStudio.tsx');
  assert.ok(studio.includes('medina-os-photo-creative-${photoFormat}.jpg'));
  const ads = read('artifacts/negis/src/pages/AdsAutomation.tsx');
  assert.ok(ads.includes('firstString(payload.fileName, "medina-os-video.mp4")'));
  const meta = read('lib/meta/marketing.ts');
  assert.ok(meta.includes('input.fileName || "medina-os-video.mp4"'));
  assert.ok(meta.includes('input.fileName?.trim() || "medina-os-video.mp4"'));
  for (const source of [studio, ads, meta]) assert.doesNotMatch(source, /negis-(?:photo-creative|video)/);
});

test('old source values remain compatible while labels use Medina OS', () => {
  const output = ts.transpileModule(read('artifacts/negis/src/lib/negisApp.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = { exports: {}, require: () => ({ crmFetch() { throw new Error('Network forbidden'); } }) };
  vm.runInNewContext(output, context);
  const api = context.exports;
  for (const value of ['negis_app', 'Negis App', 'Medina OS']) {
    assert.equal(api.sourceValueToLabel(value), 'Medina OS');
    assert.equal(api.isNegisAppSource(value), true);
  }
  assert.equal(api.sourceLabelToValue('Medina OS'), 'negis_app');
  assert.equal(api.sourceLabelToValue('Negis App'), 'negis_app');
  assert.equal(api.sourceValueToLabel('Instagram'), 'Instagram');
  assert.equal(api.isNegisAppSource('Instagram'), false);
  assert.ok(api.CRM_SOURCES.includes('Medina OS'));
  assert.ok(api.BOOKING_SOURCES.includes('Medina OS'));
  const auth = read('artifacts/negis/src/contexts/AuthContext.tsx');
  for (const key of ['negis_staff_session', 'negis_staff_user', 'negis_demo_session', 'negis_demo_workspace']) assert.ok(auth.includes(key));
});
