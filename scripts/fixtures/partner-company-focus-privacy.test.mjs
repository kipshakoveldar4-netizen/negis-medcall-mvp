import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ts = createRequire(path.join(root, 'artifacts/negis/package.json'))('typescript');
const componentFile = 'artifacts/negis/src/components/contributors/PartnerCompanyApplication.tsx';
const contractFile = 'lib/crm/partner-company-contracts.ts';
const actorId = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const expiresAt = new Date(Date.now() + 168 * 60 * 60 * 1000).toISOString();
const context = { sourceId, expiresAt, applicantEmail: 'synthetic.applicant@example.invalid',
  notice: { version: 'synthetic-v1', purpose: 'partner_company_registration', text: 'SYNTHETIC NOTICE ONLY',
    policyRevision: 'synthetic-v1', policyUrl: 'https://policy.example.invalid/privacy', sha256: 'a'.repeat(64) } };

async function compile(file) {
  const result = ts.transpileModule(await readFile(path.join(root, file), 'utf8'), { fileName: file,
    reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX } });
  assert.deepEqual(result.diagnostics ?? [], []);
  return result.outputText;
}
const componentCode = await compile(componentFile);
const contractCode = await compile(contractFile);

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function events() {
  const listeners = new Map();
  return {
    addEventListener(name, listener) {
      const group = listeners.get(name) ?? new Set();
      group.add(listener); listeners.set(name, group);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name) { for (const listener of [...listeners.get(name) ?? []]) listener(); },
    size() { return [...listeners.values()].reduce((total, group) => total + group.size, 0); },
  };
}
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value && typeof value === 'object' && 'props' in value
    ? [value, ...nodes(value.props.children)] : [];
}

// Actual component and DTO parsers; hooks, events, transport and timers are local doubles.
function fixture(t) {
  const windowEvents = events(), documentEvents = events(), stored = new Map(), timers = new Map();
  const requests = [], slots = [];
  const document = { ...documentEvents, visibilityState: 'visible' };
  const window = { ...windowEvents, sessionStorage: {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
    removeItem: key => { stored.delete(key); },
  } };
  let cursor = 0, dirty = true, disposed = false, tree, component, timerId = 0, lateWrites = 0;
  function slot(kind, initial) {
    const index = cursor++;
    slots[index] ??= { kind, ...initial() };
    assert.equal(slots[index].kind, kind);
    return slots[index];
  }
  const hooks = {
    useState(initial) {
      const state = slot('state', () => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [state.value, update => {
        if (disposed) { lateWrites++; return; }
        const next = typeof update === 'function' ? update(state.value) : update;
        if (!Object.is(next, state.value)) { state.value = next; dirty = true; }
      }];
    },
    useRef(initial) { return slot('ref', () => ({ value: { current: initial } })).value; },
    useLayoutEffect(create, deps) {
      const effect = slot('effect', () => ({ pending: true }));
      if (!effect.deps || deps.some((value, index) => !Object.is(value, effect.deps[index]))) effect.pending = true;
      effect.create = create; effect.deps = deps;
    },
  };
  function evaluate(code, imports) {
    const exports = {};
    new Script(code).runInNewContext({ exports, module: { exports }, window, document, URL, Intl, Date,
      AbortController, DOMException, Object, Error,
      fetch() { assert.fail('No HTTP or provider access is allowed'); },
      crypto: { randomUUID() { assert.fail('No company command may be created by these lifecycle tests'); } },
      setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
      clearTimeout(id) { timers.delete(id); },
      require(name) { assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`); return imports[name]; },
    });
    return exports;
  }
  const jsx = (type, props) => ({ type, props });
  const icon = () => null;
  component = evaluate(componentCode, {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': Object.fromEntries(['Building2', 'Check', 'CircleAlert', 'ExternalLink', 'LoaderCircle',
      'RefreshCw', 'Send', 'ShieldCheck', 'X'].map(name => [name, icon])),
    '../../../../../lib/crm/partner-company-contracts': evaluate(contractCode, {}),
    './partner-company-application.css': {},
  }).PartnerCompanyApplication;
  const props = { actorId, isSessionCurrent: () => true, onAccessDenied() { assert.fail('No denial is synthesized'); },
    request(options) { const gate = deferred(); requests.push({ ...options, gate }); return gate.promise; } };
  async function flush() {
    for (let pass = 0; pass < 60; pass++) {
      if (dirty && !disposed) {
        dirty = false; cursor = 0; tree = component(props);
        for (const effect of slots.filter(value => value.kind === 'effect' && value.pending)) {
          effect.cleanup?.(); effect.pending = false; effect.cleanup = effect.create();
        }
      }
      await Promise.resolve();
    }
    assert.equal(dirty, false, 'Synthetic React scheduling must settle');
  }
  function unmount() {
    if (disposed) return;
    disposed = true; dirty = false;
    for (const effect of slots.filter(value => value.kind === 'effect')) effect.cleanup?.();
    tree = null;
  }
  t.after(() => {
    unmount();
    assert.equal(windowEvents.size() + documentEvents.size(), 0, 'All lifecycle listeners are removed');
    assert.equal(timers.size, 0, 'All owned expiry timers are cleared');
    assert.equal(lateWrites, 0);
    assert.equal(stored.size, 0, 'Lifecycle checks never persist a company command');
    assert.ok(requests.every(request => request.operation === 'context'));
  });
  const form = () => nodes(tree).find(node => node.type === 'form');
  const noFields = () => assert.equal(nodes(tree).filter(node => ['form', 'input', 'select'].includes(node.type)).length, 0);
  async function ready() {
    requests.at(-1).gate.resolve(context); await flush();
    assert.ok(form());
    assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox').props.checked, false);
    for (const [name, value] of [['companyName', 'Synthetic Company'], ['ownerName', 'Synthetic Owner']]) {
      nodes(tree).find(node => node.type === 'input' && node.props.name === name).props.onChange({ target: { value } });
      await flush();
    }
    form().props.onSubmit({ preventDefault() {} }); await flush();
  }
  async function visibility(value) { document.visibilityState = value; documentEvents.dispatch('visibilitychange'); await flush(); }
  async function event(name) { windowEvents.dispatch(name); await flush(); }
  return { flush, ready, requests, form, noFields, visibility, event, unmount, timers };
}

test('blur -> hidden -> visible cannot reload the actual public-route form before focus', async t => {
  const h = fixture(t); await h.flush(); await h.ready();
  const originalRemaining = [...h.timers.values()][0].ms;
  const retainedSubmit = h.form().props.onSubmit;
  await h.event('blur'); h.noFields();
  await h.visibility('hidden'); await h.visibility('visible');
  assert.equal(h.requests.length, 1, 'A visible but unfocused form must not read private applicant context');
  h.noFields(); retainedSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.requests.length, 1);
  await h.event('focus'); assert.equal(h.requests.length, 2); await h.ready();
  assert.ok([...h.timers.values()][0].ms <= originalRemaining, 'Focus does not restart the original expiry timer');
});

test('held context stays aborted across blur and visible-before-focus', async t => {
  const h = fixture(t); await h.flush(); await h.ready();
  await h.event('focus'); const held = h.requests.at(-1);
  await h.event('blur'); h.noFields();
  assert.equal(held.signal.aborted, true); assert.equal(held.isCurrent(), false);
  await h.visibility('hidden'); await h.visibility('visible');
  assert.equal(h.requests.length, 2);
  held.gate.resolve(context); await h.flush(); h.noFields();
  await h.event('focus'); assert.equal(h.requests.length, 3); await h.ready();
  assert.equal(held.isCurrent(), false);
});

test('visibility-only revalidation remains available while focused; unmount retires listeners', async t => {
  const h = fixture(t); await h.flush(); await h.ready();
  await h.visibility('hidden'); h.noFields();
  await h.visibility('visible'); assert.equal(h.requests.length, 2); await h.ready();
  h.unmount(); await h.event('focus'); await h.visibility('visible');
  assert.equal(h.requests.length, 2); h.noFields();
});

test('focus arriving while hidden waits for visibility before requesting context', async t => {
  const h = fixture(t); await h.flush(); await h.ready();
  await h.event('blur'); await h.visibility('hidden'); await h.event('focus');
  assert.equal(h.requests.length, 1); h.noFields();
  await h.visibility('visible'); assert.equal(h.requests.length, 2); await h.ready();
});
