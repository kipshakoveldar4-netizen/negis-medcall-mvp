import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

// The real component runs against synthetic hooks/SDK only. The companion
// owned-browser fixture exercises real React commits without customer storage.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ts = createRequire(path.join(root, 'package.json'))('typescript') as typeof import('typescript');
const profileFile = 'artifacts/negis/src/components/layout/ProfileDialog.tsx';
const source = await readFile(path.join(root, profileFile), 'utf8');
function evaluate(source: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }, transformers: { before: [context => {
      const visit: import('typescript').Visitor = node => ts.isMetaProperty(node)
        ? ts.factory.createObjectLiteralExpression([ts.factory.createPropertyAssignment('env', ts.factory.createIdentifier('fixtureEnv'))])
        : ts.visitEachChild(node, visit, context);
      return file => ts.visitNode(file, visit) as import('typescript').SourceFile;
    }] } }).outputText;
  const exports: Record<string, any> = {};
  new Script(output).runInNewContext({ exports, Error, URL, Headers, Request, Response, AbortController, atob,
    fixtureEnv: {}, ...globals, require(name: string) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected profile dependency: ${name}`); return imports[name];
    } });
  return exports;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const expiresAt = Math.floor(Date.now() / 1000) + 3600;
function session(actor = 'A', revision = 'one') {
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: actor,
    session_id: `synthetic-${actor}-${revision}`, exp: expiresAt })).toString('base64url')}.c2lnbmF0dXJl`;
  return { access_token: token, refresh_token: `synthetic-refresh-${actor}`, user: { id: actor,
    email: `${actor.toLowerCase()}@example.test`, user_metadata: { full_name: `Synthetic ${actor}` } } };
}
type Node = { type: any; props: Record<string, any> };
function nodes(value: any): Node[] {
  return Array.isArray(value) ? value.flatMap(nodes) : value?.props ? [value, ...nodes(value.props.children)] : [];
}
function label(value: any): string {
  return Array.isArray(value) ? value.map(label).join('') : value?.props ? label(value.props.children) : value == null ? '' : String(value);
}
function fixture(initial: Record<string, unknown> = {}) {
  let auth = { session: session(), user: session().user, isImpersonation: false, isDemoMode: false, isSigningOut: false };
  auth = { ...auth, ...initial };
  let sdkSession: any = auth.session;
  const effects: any[] = [], slots: any[] = [], listeners = new Set<(event: string, value: any) => void>();
  const writes: unknown[] = [], messages: string[] = [], requests: Array<{ actor: string; updates: unknown }> = [];
  let cursor = 0, dirty = false, mounted = true, closed = 0, tree: any;
  const verification = deferred<'ok' | 'wrong' | 'unavailable'>();
  const updateEntered = deferred<void>();
  let sdkGate: ReturnType<typeof deferred<void>> | undefined;
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
  const hookEffect = (create: () => any, deps?: unknown[]) => {
    const index = cursor++, previous = slots[index];
    if (!previous) { const item = { create, deps, pending: true, cleanup: undefined }; slots[index] = item; effects.push(item); }
    else { previous.pending = !deps || !previous.deps || deps.some((item, i) => !Object.is(item, previous.deps[i])); previous.create = create; previous.deps = deps; }
  };
  const hooks = {
    useState(initial: any) { const index = cursor++; const item = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [item.value, (next: any) => { writes.push(next); item.value = typeof next === 'function' ? next(item.value) : next; dirty = true; }]; },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useLayoutEffect: hookEffect, useEffect: hookEffect,
  };
  const sdk = { onAuthStateChange(callback: (event: string, value: any) => void) {
    listeners.add(callback); return { data: { subscription: { unsubscribe() { listeners.delete(callback); } } } };
  }, getSession: async () => ({ data: { session: sdkSession }, error: null }),
  async updateUser(updates: unknown) { if (sdkGate) await sdkGate.promise;
    requests.push({ actor: sdkSession.user.id, updates }); return { data: { user: sdkSession.user }, error: null }; } };
  const modules: Record<string, unknown> = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-dom': { flushSync: (callback: () => void) => callback() },
    'lucide-react': { KeyRound: 'KeyRound', User: 'User', X: 'X' },
    sonner: { toast: { success: (message: string) => messages.push(`success:${message}`), error: (message: string) => messages.push(`error:${message}`) } },
    '@/contexts/AuthContext': { useAuth: () => ({ ...auth, applyConfirmedProfile(confirmed: any, guard: () => boolean) {
      if (guard() && confirmed.id === auth.user?.id) auth = { ...auth, user: { ...auth.user,
        user_metadata: { ...auth.user.user_metadata, full_name: confirmed.user_metadata.full_name } } };
    } }) },
    // This profile harness needs only the observer facade, never guarded auth writes.
    '@/lib/supabase': { hasSupabaseFrontendEnv: true, supabase: { auth: sdk },
      sessionAuth: { onAuthStateChange: sdk.onAuthStateChange }, verifyCurrentPassword: () => verification.promise },
    '../../../../../lib/auth/password-rules': { PASSWORD_RULE_HINT: 'Synthetic rules', validatePasswordRules: () => [] },
    './PushSettings': { PushSettings: 'PushSettings' },
    '../../../../../lib/auth/staff-logins': { isSyntheticEmail: () => false, loginFromEmail: (email: string) => email },
  };
  const helperSource = requireHelperSource;
  if (helperSource) modules['@/lib/profileSession'] = evaluate(helperSource, {
    '@supabase/supabase-js': { AuthClient: class {
      session: any; constructor(private options: any) {}
      async setSession(value: any) {
        const reply = await this.options.fetch('https://profile.example.test/auth/v1/user', { method: 'GET', headers: { Authorization: `Bearer ${value.access_token}` } });
        this.session = { ...value, user: await reply.json() }; return { data: { session: this.session, user: this.session.user }, error: null };
      }
      async updateUser(updates: unknown) {
        updateEntered.resolve();
        if (sdkGate) await sdkGate.promise;
        const reply = await this.options.fetch('https://profile.example.test/auth/v1/user', { method: 'PUT', headers: { Authorization: `Bearer ${this.session.access_token}` }, body: JSON.stringify(updates) });
        return { data: { user: await reply.json() }, error: null };
      }
      async stopAutoRefresh() {}
    } },
  }, { fixtureEnv: { VITE_SUPABASE_URL: 'https://profile.example.test', VITE_SUPABASE_ANON_KEY: 'synthetic-public-key' },
    crypto: { randomUUID: () => 'synthetic-profile-operation' }, fetch: async (_url: unknown, init: RequestInit) => {
      const token = new Headers(init.headers).get('Authorization');
      const actor = token === `Bearer ${session('A').access_token}` ? 'A' : 'B';
      if (init.method === 'PUT') requests.push({ actor, updates: JSON.parse(String(init.body)) });
      return Response.json(session(actor).user);
    } });
  const component = evaluate(source, modules);
  function render() {
    assert.ok(mounted);
    for (let i = 0; i < 12; i++) {
      dirty = false; cursor = 0; tree = component.ProfileDialog({ onClose: () => { closed++; } });
      const pending = effects.filter(effect => effect.pending);
      pending.forEach(effect => effect.cleanup?.()); pending.forEach(effect => { effect.pending = false; effect.cleanup = effect.create(); });
      if (!dirty) return;
    }
    assert.fail('Profile effect render loop');
  }
  function input(id: string, value: string) { const node = nodes(tree).find(node => node.props.id === id); assert.ok(node, id);
    node.props.onChange({ target: { value } }); render(); }
  render();
  return {
    input, render, messages, requests, writes, verification, updateEntered,
    password() { input('profile-current-password', 'SyntheticCurrent42'); input('profile-new-password', 'SyntheticNew42'); input('profile-repeat-password', 'SyntheticNew42'); },
    save() { const button = nodes(tree).find(node => node.type === 'button' && /^(Сохранить|Сохраняем)/.test(label(node.props.children))); assert.ok(button); return button.props.onClick(); },
    saveCallback() { const button = nodes(tree).find(node => node.type === 'button' && /^(Сохранить|Сохраняем)/.test(label(node.props.children))); assert.ok(button); return button.props.onClick; },
    deferSdk() { sdkGate = deferred<void>(); return sdkGate; },
    emit(actor: string | null, event = actor ? 'SIGNED_IN' : 'SIGNED_OUT', revision = 'one') {
      sdkSession = actor ? session(actor, revision) : null; listeners.forEach(callback => callback(event, sdkSession));
    },
    change(actor: string) { auth = { ...auth, session: session(actor), user: session(actor).user }; render(); },
    patch(patch: Partial<typeof auth>) { auth = { ...auth, ...patch }; render(); },
    tree: () => tree, closed: () => closed,
    callback(id: string) { const node = nodes(tree).find(node => node.props.id === id); assert.ok(node); return node.props.onChange; },
    close() { const button = nodes(tree).find(node => node.props['aria-label'] === 'Закрыть профиль'); assert.ok(button); return button.props.onClick(); },
    unmount() { if (!mounted) return; mounted = false; effects.forEach(effect => effect.cleanup?.()); },
  };
}
let requireHelperSource = '';
try { requireHelperSource = await readFile(path.join(root, 'artifacts/negis/src/lib/profileSession.ts'), 'utf8'); } catch {}

test('profile A verification cannot update the later SDK account B', async () => {
  const f = fixture(); f.password(); const saving = f.save();
  f.emit('B'); f.verification.resolve('ok'); await saving;
  assert.equal(f.requests.length, 0, 'An A password check must never authorize a global B update');
  assert.equal(f.messages.some(value => value.startsWith('success:')), false); f.unmount();
});

test('profile checked before SDK await still cannot dispatch under B', { timeout: 15_000 }, async () => {
  const f = fixture(); f.input('profile-full-name', 'Changed A'); const gate = f.deferSdk(); const saving = f.save();
  await f.updateEntered.promise; f.emit('B'); gate.resolve(); await saving;
  assert.equal(f.requests.length, 0, 'Checking identity only before global updateUser is insufficient');
  assert.equal(f.messages.some(value => value.startsWith('success:')), false); f.unmount();
});

for (const mode of ['ABA', 'unmount', 'impersonation', 'demo', 'signout', 'context-account', 'session-mismatch', 'new-session'] as const) {
  test(`profile ${mode} while verifying suppresses update, messages and later state writes`, async () => {
    const f = fixture(); f.password(); const oldInput = f.callback('profile-new-password'); const saving = f.save();
    if (mode === 'ABA') { f.emit('B'); f.emit('A'); }
    else if (mode === 'unmount') f.unmount();
    else if (mode === 'impersonation') f.patch({ isImpersonation: true });
    else if (mode === 'demo') f.patch({ isDemoMode: true });
    else if (mode === 'signout') f.emit(null);
    else if (mode === 'context-account') f.change('B');
    else if (mode === 'new-session') f.emit('A', 'SIGNED_IN', 'two');
    else f.patch({ session: session('B') });
    const writes = f.writes.length;
    oldInput({ target: { value: 'MustNotReturn42' } });
    f.verification.resolve('ok'); await saving;
    assert.equal(f.requests.length, 0); assert.deepEqual(f.messages, []);
    assert.equal(f.writes.length, writes, 'Stale handlers/finally must not touch the later UI');
    f.unmount();
  });
}

for (const mode of ['ABA', 'unmount', 'impersonation'] as const) {
  test(`profile ${mode} during isolated SDK wait refuses the actual PUT transport`, { timeout: 15_000 }, async () => {
    const f = fixture(); const gate = f.deferSdk(); const saving = f.save(); await f.updateEntered.promise;
    if (mode === 'ABA') { f.emit('B'); f.emit('A'); }
    else if (mode === 'unmount') f.unmount();
    else f.patch({ isImpersonation: true });
    const writes = f.writes.length; gate.resolve(); await saving;
    assert.equal(f.requests.length, 0); assert.deepEqual(f.messages, []); assert.equal(f.writes.length, writes); f.unmount();
  });
}

for (const result of ['wrong', 'unavailable'] as const) {
  test(`profile verification ${result} clears passwords and never updates`, async () => {
    const f = fixture(); f.password(); const saving = f.save(); f.verification.resolve(result); await saving; f.render();
    assert.equal(f.requests.length, 0); assert.equal(f.messages.length, 1); assert.match(f.messages[0], /^error:/);
    for (const node of nodes(f.tree()).filter(node => node.props.type === 'password')) assert.equal(node.props.value, '');
    f.unmount();
  });
}

test('same-user SDK refresh allows one original-actor password/name update and clears secrets', async () => {
  const f = fixture(); f.password(); const saving = f.save(); f.emit('A', 'TOKEN_REFRESHED');
  f.verification.resolve('ok'); await saving;
  assert.deepEqual(f.requests, [{ actor: 'A', updates: { data: { full_name: 'Synthetic A' }, password: 'SyntheticNew42' } }]);
  assert.equal(f.messages.length, 1); assert.match(f.messages[0], /^success:/); assert.equal(f.closed(), 1); f.unmount();
});

test('duplicate save and captured close callback cannot evade the pending operation lock', async () => {
  const f = fixture(); f.password(); const saving = f.save(); f.close(); await f.save(); assert.equal(f.closed(), 0);
  f.verification.resolve('ok'); await saving; assert.equal(f.requests.length, 1); assert.equal(f.closed(), 1); f.unmount();
});

test('demo read-only profile can still close without an auth session', () => {
  const f = fixture({ isDemoMode: true, session: null, user: null });
  assert.ok(f.tree()); f.close(); assert.equal(f.closed(), 1); assert.equal(f.requests.length, 0); f.unmount();
});

test('same actor mismatched session can never edit the other session user', async () => {
  const f = fixture(); f.patch({ session: session('B') });
  assert.equal(f.tree(), null); assert.equal(f.requests.length, 0); f.unmount();
});

test('captured read-only save callback cannot toast into a later or unmounted session', async () => {
  const f = fixture({ isImpersonation: true }); const oldSave = f.saveCallback(); f.unmount();
  const writes = f.writes.length; await oldSave(); assert.deepEqual(f.messages, []); assert.equal(f.writes.length, writes);
});

const actualSdk = createRequire(path.join(root, 'artifacts/negis/package.json'))('@supabase/supabase-js');
test('installed SDK actually binds GET/PUT to original JWT and never uses global auth or persistence', async () => {
  const calls: Array<{ method: string; token: string | null }> = [];
  let current = true;
  const helper = evaluate(requireHelperSource, { '@supabase/supabase-js': actualSdk }, {
    fixtureEnv: { VITE_SUPABASE_URL: 'https://profile.example.test', VITE_SUPABASE_ANON_KEY: 'synthetic-public-key' },
    crypto, fetch: async (_url: unknown, init: RequestInit) => {
      calls.push({ method: String(init.method), token: new Headers(init.headers).get('Authorization') });
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
      return Response.json(session().user);
    },
  });
  await helper.updateProfileForSession(session(), { data: { full_name: 'Changed A' } }, () => current, new AbortController().signal);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PUT']);
  assert.ok(calls.every(call => call.token === `Bearer ${session().access_token}`));
  current = false;
  await assert.rejects(helper.updateProfileForSession(session(), { password: 'SyntheticNew42' }, () => current, new AbortController().signal));
  assert.equal(calls.length, 2);
});

test('installed SDK refuses a mismatched user from binding GET before any PUT', async () => {
  const calls: string[] = [];
  const helper = evaluate(requireHelperSource, { '@supabase/supabase-js': actualSdk }, {
    fixtureEnv: { VITE_SUPABASE_URL: 'https://profile.example.test', VITE_SUPABASE_ANON_KEY: 'synthetic-public-key' }, crypto,
    fetch: async (_url: unknown, init: RequestInit) => { calls.push(String(init.method)); return Response.json(session('B').user); },
  });
  await assert.rejects(helper.updateProfileForSession(session(), { data: { full_name: 'A' } }, () => true, new AbortController().signal));
  assert.deepEqual(calls, ['GET']);
});

test('aborted isolated operation performs no SDK or network dispatch', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const helper = evaluate(requireHelperSource, { '@supabase/supabase-js': actualSdk }, {
    fixtureEnv: { VITE_SUPABASE_URL: 'https://profile.example.test', VITE_SUPABASE_ANON_KEY: 'synthetic-public-key' }, crypto,
    fetch: async () => { calls++; throw Error('Unexpected dispatch'); },
  });
  await assert.rejects(helper.updateProfileForSession(session(), { password: 'SyntheticNew42' }, () => true, controller.signal));
  assert.equal(calls, 0);
});

for (const point of ['before-PUT', 'issued-PUT'] as const) {
  test(`installed SDK invalidation at ${point} refuses further dispatch or stale success`, { timeout: 15_000 }, async () => {
    const entered = deferred<void>(), gate = deferred<void>(); let current = true;
    const methods: string[] = [], abort = new AbortController();
    const helper = evaluate(requireHelperSource, { '@supabase/supabase-js': actualSdk }, {
      fixtureEnv: { VITE_SUPABASE_URL: 'https://profile.example.test', VITE_SUPABASE_ANON_KEY: 'synthetic-public-key' }, crypto,
      fetch: async (_url: unknown, init: RequestInit) => {
        methods.push(String(init.method));
        assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${session().access_token}`);
        if ((point === 'before-PUT' && init.method === 'GET') || (point === 'issued-PUT' && init.method === 'PUT')) {
          entered.resolve(); await gate.promise;
        }
        return Response.json(session().user);
      },
    });
    const saving = helper.updateProfileForSession(session(), { password: 'SyntheticNew42' }, () => current, abort.signal);
    await entered.promise; current = false; abort.abort(); gate.resolve(); await assert.rejects(saving);
    assert.deepEqual(methods, point === 'before-PUT' ? ['GET'] : ['GET', 'PUT']);
  });
}

test('owned browser: actual React ProfileDialog and installed auth SDK with fake network only', { timeout: 180_000 }, async t => {
  const { runProfileSessionBrowser } = await import('../fixtures/profile-session-browser.mjs');
  await runProfileSessionBrowser(t);
});

test('owned browser: actual AuthProvider and Sidebar publish only confirmed same-lifetime display metadata', { timeout: 180_000 }, async t => {
  const { runProfileSessionBrowser } = await import('../fixtures/profile-session-browser.mjs');
  await runProfileSessionBrowser(t, true);
});
