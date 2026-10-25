import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { legacyServerAccessRequirements as requirements, legacyServerPrivilegeMatrix } from './legacy-server-access-requirements.mjs';
const { CRM_RESOURCE_AUTHORIZATION, CRM_ROUTE_AUTHORIZATION } = createRequire(import.meta.url)('../../lib/crm/authorization.ts');

// Source evidence only. Do not import the server, create an SDK client, call a
// route, or mistake compiler inspection for native PostgreSQL ACL authority.
const source = async file => {
  const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
};
const server = await source('lib/crm/server.ts');
const persistence = await source('lib/targeting-agent/persistence.ts');
const api = await source('api/crm/[...path].ts');
const descendants = (node, predicate) => {
  const found = [];
  const visit = child => { if (predicate(child)) found.push(child); ts.forEachChild(child, visit); };
  visit(node); return found;
};
const namedFunction = (module, name) => {
  const found = module.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1, `${module.fileName}: ${name}`); return found[0];
};
const property = (object, name) => {
  assert.ok(ts.isObjectLiteralExpression(object));
  const found = object.properties.filter(node => node.name?.text === name);
  assert.equal(found.length, 1, `object property ${name}`); return found[0];
};
const configs = descendants(server, node => ts.isVariableDeclaration(node) && node.name.getText(server) === 'configs');
assert.equal(configs.length, 1);
const string = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const callsNamed = (node, name) => descendants(node, value => ts.isCallExpression(value)
  && (ts.isIdentifier(value.expression) && value.expression.text === name));
const tableCalls = (node, operation, target) => descendants(node, value => {
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression) || value.expression.name.text !== operation) return false;
  const from = value.expression.expression;
  if (!ts.isCallExpression(from) || !ts.isPropertyAccessExpression(from.expression) || from.expression.name.text !== 'from') return false;
  return string(from.arguments[0]) ? from.arguments[0].text === target : from.arguments[0]?.getText() === target;
});
const fields = object => {
  assert.ok(ts.isObjectLiteralExpression(object));
  return object.properties.map(node => {
    assert.ok(ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)); return node.name.text;
  });
};

test('seven current adapters require exactly 17 minimum privileges, without DELETE or blanket grants', () => {
  assert.equal(requirements.length, 7);
  assert.equal(requirements.reduce((n, requirement) => n + requirement.privileges.length, 0), 17);
  assert.deepEqual(Object.keys(legacyServerPrivilegeMatrix), requirements.map(requirement => requirement.table));
  for (const requirement of requirements) {
    assert.ok(Object.isFrozen(requirement)); assert.ok(Object.isFrozen(requirement.privileges));
    assert.equal(new Set(requirement.columns).size, requirement.columns.length);
    assert.ok(requirement.columns.includes('id')); assert.ok(requirement.columns.includes('created_at'));
    assert.ok(!requirement.privileges.some(value => ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL'].includes(value)));
  }
  assert.deepEqual(legacyServerPrivilegeMatrix.meta_launch_audit_logs, ['INSERT']);
  assert.deepEqual(legacyServerPrivilegeMatrix.targeting_reports, ['INSERT']);
});

for (const requirement of requirements.filter(item => item.authority.resource)) {
  const { resource } = requirement.authority;
  test(`${requirement.table}: actual config, routed methods and persisted columns ground SELECT/INSERT/UPDATE`, () => {
    const config = property(configs[0].initializer, resource).initializer;
    assert.equal(property(config, 'table').initializer.text, requirement.table);
    assert.deepEqual([...CRM_RESOURCE_AUTHORIZATION[resource].methods], ['GET', 'POST', 'PATCH']);
    assert.ok(!CRM_RESOURCE_AUTHORIZATION[resource].disabledMethods?.length);
    const row = property(config, 'toRow').initializer;
    assert.ok(ts.isArrowFunction(row)); assert.ok(ts.isParenthesizedExpression(row.body));
    for (const column of fields(row.body.expression)) assert.ok(requirement.columns.includes(column), `${requirement.table}.${column}: schema preflight must cover every current written field`);
    assert.ok(tableCalls(namedFunction(server, 'listItems'), 'select', 'config.table').length);
    assert.ok(tableCalls(namedFunction(server, 'createItem'), 'insert', 'config.table').length);
    assert.ok(tableCalls(namedFunction(server, 'patchItem'), 'update', 'config.table').length);
    for (const [method, handler] of [['GET', 'listItems'], ['POST', 'createItem'], ['PATCH', 'patchItem']]) {
      const condition = descendants(namedFunction(server, 'handleCrmResource'), node => ts.isIfStatement(node)
        && descendants(node.expression, value => string(value) && value.text === method).length);
      assert.equal(condition.length, 1, method); assert.ok(callsNamed(condition[0].thenStatement, handler).length);
    }
    assert.ok(callsNamed(api, 'handleCrmResource').length, 'registered resource must reach the real generic handler');
  });
}

test('release-check POST is a real key-based upsert, so UPDATE is not inferred from an unused config', () => {
  const config = property(configs[0].initializer, 'release-checks').initializer;
  assert.equal(property(config, 'upsertConflict').initializer.text, 'workspace_id,check_key');
  assert.ok(tableCalls(namedFunction(server, 'createItem'), 'upsert', 'config.table').length);
});

test('meta-account POST has both guarded existing-row UPDATE and new-row INSERT; provisioning boundaries remain intact', () => {
  const create = namedFunction(server, 'createItem');
  assert.ok(tableCalls(create, 'select', 'config.table').length);
  assert.ok(tableCalls(create, 'update', 'config.table').length);
  assert.ok(tableCalls(create, 'insert', 'config.table').length);
  assert.ok(callsNamed(api, 'requireMetaProvisionedWorkspace').length);
  assert.ok(callsNamed(api, 'requireMetaProvisionedAdAccount').length);
});

test('Meta launch persistence and its write-only audit are called by the guarded active route', () => {
  const launch = namedFunction(server, 'handleMetaLaunch');
  assert.ok(callsNamed(launch, 'persistMetaLaunch').length); assert.ok(callsNamed(launch, 'insertMetaAuditLog').length);
  assert.deepEqual([...CRM_ROUTE_AUTHORIZATION['meta-launch'].methods], ['POST']);
  assert.ok(callsNamed(api, 'handleMetaLaunch').length);
  assert.ok(tableCalls(namedFunction(server, 'persistMetaLaunch'), 'insert', 'config.table').length);
  const write = tableCalls(namedFunction(server, 'insertMetaAuditLog'), 'insert', 'meta_launch_audit_logs');
  assert.equal(write.length, 1);
  const requirement = requirements.find(item => item.table === 'meta_launch_audit_logs');
  for (const column of fields(write[0].arguments[0])) assert.ok(requirement.columns.includes(column));
  assert.equal(tableCalls(namedFunction(server, 'insertMetaAuditLog'), 'select', 'meta_launch_audit_logs').length, 0);
});

test('targeting persistence really has conditional INSERT/upsert and workspace-scoped SELECT', () => {
  const save = namedFunction(persistence, 'persistTargetingCampaignIfAvailable');
  assert.equal(tableCalls(save, 'insert', 'targeting_campaigns').length, 1);
  assert.equal(tableCalls(save, 'upsert', 'targeting_campaigns').length, 1);
  const row = descendants(save, node => ts.isVariableDeclaration(node) && node.name.getText(persistence) === 'row');
  assert.equal(row.length, 1);
  for (const column of fields(row[0].initializer)) assert.ok(requirements.find(item => item.table === 'targeting_campaigns').columns.includes(column));
  const lookup = namedFunction(persistence, 'campaignBelongsToWorkspace');
  assert.equal(tableCalls(lookup, 'select', 'targeting_campaigns').length, 1);
  const eq = descendants(lookup, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'eq').map(node => node.arguments[0]?.text);
  assert.ok(eq.includes('id')); assert.ok(eq.includes('workspace_id'));
});

for (const file of ['api/targeting/report.ts', 'api/targeting/reports/[campaignId].ts']) {
  test(`${file}: ownership SELECT precedes external report and append-only receipt INSERT`, async () => {
    const module = await source(file);
    const guard = callsNamed(module, 'campaignBelongsToWorkspace');
    const persist = callsNamed(module, 'persistTargetingReportIfAvailable');
    const getReport = descendants(module, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'getCampaignReport');
    assert.equal(guard.length, 1); assert.equal(persist.length, 1); assert.equal(getReport.length, 1);
    assert.ok(guard[0].pos < getReport[0].pos); assert.ok(getReport[0].pos < persist[0].pos);
    assert.ok(callsNamed(module, 'authorizePrivateRoute').length);
  });
}

test('targeting launch route calls persistence with verified workspace, not browser workspace data', async () => {
  const module = await source('api/targeting/launch.ts');
  const call = callsNamed(module, 'persistTargetingCampaignIfAvailable');
  assert.equal(call.length, 1); assert.equal(call[0].arguments[2].getText(module), 'context.workspaceId');
  assert.ok(callsNamed(module, 'authorizePrivateRoute').length);
});

test('targeting report appends only: no returning SELECT, UPDATE or DELETE permission is inferred', () => {
  const save = namedFunction(persistence, 'persistTargetingReportIfAvailable');
  const insert = tableCalls(save, 'insert', 'targeting_reports'); assert.equal(insert.length, 1);
  const requirement = requirements.find(item => item.table === 'targeting_reports');
  for (const column of fields(insert[0].arguments[0])) assert.ok(requirement.columns.includes(column));
  assert.equal(tableCalls(save, 'select', 'targeting_reports').length, 0);
  assert.equal(tableCalls(save, 'update', 'targeting_reports').length, 0);
  assert.equal(tableCalls(save, 'delete', 'targeting_reports').length, 0);
});

test('native gate source uses canonical inet host rather than address text with an optional /32 mask', async () => {
  const module = await source('scripts/fixtures/migration-chain-native.test.mjs');
  const probes = descendants(module, node => string(node) && node.text.includes('inet_server_addr'));
  assert.equal(probes.length, 1);
  assert.equal(probes[0].text,
    'select current_user, current_database() as db, pg_catalog.host(pg_catalog.inet_server_addr()) as host');
  assert.ok(callsNamed(module, 'startNativePostgres').length, 'Attestation remains the existing owned helper, not a new connection path');
});

test('native gate Telegram admission uses a fresh per-intent UUID, not the former permanent test identity', async () => {
  const module = await source('scripts/fixtures/migration-chain-native.test.mjs');
  const admission = callsNamed(module, 'one').filter(node => string(node.arguments[1])
    && node.arguments[1].text.startsWith('select public.admit_content_telegram_delivery('));
  assert.equal(admission.length, 1);
  const args = admission[0].arguments[2]; assert.ok(ts.isArrayLiteralExpression(args));
  const intent = args.elements[3]; assert.ok(ts.isCallExpression(intent));
  assert.equal(intent.expression.getText(module), 'randomUUID');
  assert.equal(intent.arguments.length, 0);
});
