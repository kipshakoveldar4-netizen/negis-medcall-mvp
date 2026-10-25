import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localRequire = createRequire(path.join(root, 'scripts/package.json'));
const { transformSync } = createRequire(localRequire.resolve('tsx'))('esbuild') as {
  transformSync(source: string, options: {
    loader: 'ts'; format: 'cjs'; target: string; sourcefile: string;
    define: Record<string, string>; supported: Record<string, boolean>;
  }): { code: string };
};

// Read only these source files. There is no Vite/config loader, application
// dependency resolution, environment-file lookup, SDK, storage or real fetch.
const files = {
  supabase: 'artifacts/negis/src/lib/supabase.ts',
  profile: 'artifacts/negis/src/lib/profileSession.ts',
  api: 'artifacts/negis/src/lib/api.ts',
  control: 'artifacts/medina-control/src/lib/control-config.ts',
} as const;
type Reader = keyof typeof files;
const sources = Object.fromEntries(Object.entries(files).map(([name, file]) =>
  [name, readFileSync(path.join(root, file), 'utf8')],
)) as Record<Reader, string>;
type Env = Record<string, string | undefined>;

const BROWSER_ORIGIN = 'https://browser.example.test';
const DATABASE = 'https://database.example.test';
const API = 'https://api.example.test';
const PUBLIC_KEY = 'sb_publishable_synthetic_browser_bindings';
const FALLBACK_KEY = 'sb_publishable_synthetic_fallback';
const APP_BASE = '/synthetic-app';
const ROUTE = '/api/crm/synthetic-binding-probe';
const USER = { id: 'synthetic-browser-bindings-actor' };
const SESSION = {
  access_token: 'synthetic-browser-bindings-access',
  refresh_token: 'synthetic-browser-bindings-refresh',
  user: USER,
};
const configured: Env = {
  BASE_URL: `${APP_BASE}/`,
  VITE_SUPABASE_URL: DATABASE,
  VITE_SUPABASE_ANON_KEY: PUBLIC_KEY,
  VITE_API_BASE_URL: API,
  VITE_MEDINA_API_URL: API,
};
const emptyControl = {
  VITE_MEDINA_CONTROL_MODE: '', VITE_MEDINA_API_URL: '',
  VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '',
};

type ControlConfig = { ready: false; error: string }
  | { ready: true; apiOrigin: string; supabaseUrl: string; anonKey: string };
type Modules = {
  supabase: {
    hasSupabaseFrontendEnv: boolean;
    verifyCurrentPassword(email: string, password: string): Promise<string>;
  };
  profile: {
    updateProfileForSession(session: typeof SESSION, updates: { data: { name: string } },
      isCurrent: () => boolean, signal: AbortSignal): Promise<typeof USER>;
  };
  api: {
    API_BASE_URL: string;
    apiUrl(path: string): string;
    publicApiUrl(path: string): string;
    crmFetch(path: string, init?: RequestInit & { accessToken?: string }): Promise<Response>;
  };
  control: {
    resolveControlConfig(env: Env, development?: boolean): ControlConfig;
    resolveControlBrowserEnv(env: Env, development?: boolean): Record<string, string>;
  };
};
type AuthOptions = {
  url: string; headers: { apikey: string }; storageKey: string;
  persistSession: boolean; autoRefreshToken: boolean;
  detectSessionInUrl: boolean; skipAutoInitialize: boolean;
  fetch(input: string, init: RequestInit): Promise<Response>;
};

function override(env: Env, key: string, value: string | undefined): Env {
  const result = { ...env };
  if (value === undefined) delete result[key];
  else result[key] = value;
  return result;
}

function compile(reader: Reader, browserBindings: Env): string {
  // In-memory syntax/define transformation only, not an application build.
  // JSON captures a build-time snapshot; it never consults the host environment.
  return transformSync(sources[reader], {
    loader: 'ts', format: 'cjs', target: 'es2022', sourcefile: files[reader],
    define: { 'import.meta.env': JSON.stringify(browserBindings) },
    // Lazy imports must use the same closed synthetic require map as static ones.
    supported: { 'dynamic-import': false },
  }).code;
}

function fixture<T extends Reader>(reader: T, browserBindings: Env,
  runtimeBindings: Env = {}, code = compile(reader, browserBindings)) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const clients: Array<{ url: string; key: string }> = [];
  const authClients: AuthOptions[] = [];
  const imports: string[] = [];
  let stopped = 0;
  // A recorder, intentionally not SDK URL/key validation. These tests establish
  // what each production reader passes through, not which inputs an SDK accepts.
  const sdk = {
    createClient(url: string, key: string) {
      clients.push({ url, key });
      return Object.freeze({ synthetic: true });
    },
    AuthClient: class {
      private credentials?: { access_token: string; refresh_token: string };
      constructor(private options: AuthOptions) { authClients.push(options); }
      async setSession(credentials: { access_token: string; refresh_token: string }) {
        this.credentials = { ...credentials };
        const response = await this.options.fetch(`${this.options.url}/user`, {
          method: 'GET', headers: { Authorization: `Bearer ${credentials.access_token}` },
        });
        return { data: { user: await response.json() }, error: null };
      }
      async updateUser(updates: unknown) {
        assert.ok(this.credentials);
        const response = await this.options.fetch(`${this.options.url}/user`, {
          method: 'PUT', headers: { Authorization: `Bearer ${this.credentials.access_token}` },
          body: JSON.stringify(updates),
        });
        return { data: { user: await response.json() }, error: null };
      }
      async stopAutoRefresh() { stopped++; }
    },
  };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports,
    // This is a separate, explicit synthetic object, never the host process.env.
    process: { env: runtimeBindings },
    window: { location: { origin: BROWSER_ORIGIN, hash: '', search: '' } },
    URL, Headers, Response, DOMException, atob,
    crypto: { randomUUID: () => 'synthetic-browser-binding-operation' },
    fetch: async (input: string, init: RequestInit = {}) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify(USER), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
    require(name: string) {
      imports.push(name);
      if (name === '@supabase/supabase-js' && (reader === 'supabase' || reader === 'profile')) return sdk;
      if (name === '@/lib/serverAuth' && reader === 'api') {
        return { getSupabaseAccessToken: async () => '' };
      }
      throw new Error(`Unexpected browser-binding dependency: ${name}`);
    },
  };
  new Script(code, { filename: `synthetic-${reader}-bindings.cjs` })
    .runInNewContext(sandbox, { timeout: 1_000 });
  return {
    reader: module.exports as Modules[T], requests, clients, authClients, imports,
    stopped: () => stopped,
  };
}

async function checkProfile(env: Env, base: string | null, key = PUBLIC_KEY,
  runtime: Env = {}, code?: string) {
  const f = fixture('profile', env, runtime, code);
  const signal = new AbortController().signal;
  const updating = f.reader.updateProfileForSession(
    SESSION, { data: { name: 'Synthetic actor' } }, () => true, signal,
  );
  if (base === null) {
    await assert.rejects(updating, { message: 'Profile session is unavailable' });
    assert.equal(f.authClients.length, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.stopped(), 0);
  } else {
    assert.deepEqual(await updating, USER);
    assert.equal(f.authClients.length, 1);
    const options = f.authClients[0];
    assert.equal(options.url, `${base}/auth/v1`);
    assert.equal(options.headers.apikey, key);
    assert.equal(options.persistSession, false);
    assert.equal(options.autoRefreshToken, false);
    assert.equal(options.detectSessionInUrl, false);
    assert.equal(options.skipAutoInitialize, true);
    assert.deepEqual(f.requests.map(({ url, init }) => [url, init.method]), [
      [`${base}/auth/v1/user`, 'GET'], [`${base}/auth/v1/user`, 'PUT'],
    ]);
    for (const { init } of f.requests) {
      assert.equal(new Headers(init.headers).get('apikey'), key.trim());
      assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${SESSION.access_token}`);
      assert.equal(init.signal, signal);
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
    }
    assert.equal(f.stopped(), 1);
  }
  assert.deepEqual(f.imports, ['@supabase/supabase-js']);
  return f;
}

type UrlCase = {
  label: string; value: string | undefined; sdk: string;
  profile: string | null; control: boolean;
};
const urlCases: UrlCase[] = [
  { label: 'unset', value: undefined, sdk: 'https://placeholder.supabase.co', profile: null, control: false },
  { label: 'empty', value: '', sdk: 'https://placeholder.supabase.co', profile: null, control: false },
  { label: 'whitespace', value: ' \t ', sdk: ' \t ', profile: ' \t ', control: false },
  { label: 'slash', value: '/', sdk: '/', profile: null, control: false },
  { label: 'valid synthetic origin', value: DATABASE, sdk: DATABASE, profile: DATABASE, control: true },
  { label: 'one trailing slash', value: `${DATABASE}/`, sdk: `${DATABASE}/`, profile: DATABASE, control: true },
  { label: 'two trailing slashes', value: `${DATABASE}//`, sdk: `${DATABASE}//`, profile: `${DATABASE}/`, control: false },
  { label: 'padded synthetic origin', value: `  ${DATABASE}/  `, sdk: `  ${DATABASE}/  `, profile: `  ${DATABASE}/  `, control: true },
];

for (const row of urlCases) {
  test(`Supabase/profile/Control URL readers: ${row.label}`, async () => {
    const env = override(configured, 'VITE_SUPABASE_URL', row.value);
    const supabase = fixture('supabase', env);
    assert.deepEqual(supabase.clients, [{ url: row.sdk, key: PUBLIC_KEY }]);
    assert.equal(supabase.reader.hasSupabaseFrontendEnv, Boolean(row.value));
    assert.equal(await supabase.reader.verifyCurrentPassword('actor@example.test', 'synthetic-password'),
      row.value ? 'ok' : 'unavailable');
    assert.deepEqual(supabase.requests.map(request => request.url), row.value
      ? [`${row.sdk}/auth/v1/token?grant_type=password`] : []);
    await checkProfile(env, row.profile);

    const control = fixture('control', {}).reader;
    const resolved = control.resolveControlConfig(env);
    assert.equal(resolved.ready, row.control);
    if (resolved.ready) {
      assert.deepEqual({ ...resolved }, { ready: true, apiOrigin: API, supabaseUrl: DATABASE, anonKey: PUBLIC_KEY });
      assert.equal(control.resolveControlBrowserEnv(env).VITE_SUPABASE_URL, DATABASE);
    } else {
      assert.ok(resolved.error);
      assert.deepEqual({ ...control.resolveControlBrowserEnv(env) }, emptyControl);
    }
  });
}

const keyCases = [
  { label: 'unset', value: undefined, present: false, control: false },
  { label: 'empty', value: '', present: false, control: false },
  { label: 'whitespace', value: ' \t ', present: true, control: false },
  { label: 'slash', value: '/', present: true, control: false },
  { label: 'valid synthetic key', value: PUBLIC_KEY, present: true, control: true },
  { label: 'padded synthetic key', value: `  ${PUBLIC_KEY}  `, present: true, control: true },
];
for (const fallback of [false, true]) {
  for (const row of keyCases) {
    test(`public key ${row.label}; non-Vite fallback ${fallback ? 'present' : 'absent'}`, async () => {
      const env = override({ ...configured, ...(fallback ? { SUPABASE_ANON_KEY: FALLBACK_KEY } : {}) },
        'VITE_SUPABASE_ANON_KEY', row.value);
      const ready = row.present || fallback;
      const expectedKey = row.value || (fallback ? FALLBACK_KEY : 'placeholder');
      const supabase = fixture('supabase', env);
      assert.equal(supabase.reader.hasSupabaseFrontendEnv, ready);
      assert.deepEqual(supabase.clients, [{ url: DATABASE, key: expectedKey }]);
      await checkProfile(env, ready ? DATABASE : null, expectedKey);
      const control = fixture('control', {}).reader;
      const resolved = control.resolveControlConfig(env);
      assert.equal(resolved.ready, row.control, 'Control must not use the non-Vite key fallback');
      if (resolved.ready) assert.equal(resolved.anonKey, PUBLIC_KEY);
      else assert.deepEqual({ ...control.resolveControlBrowserEnv(env) }, emptyControl);
    });
  }
}

const apiCases = [
  { label: 'unset', value: undefined, base: APP_BASE, explicit: false },
  { label: 'empty', value: '', base: APP_BASE, explicit: false },
  { label: 'whitespace', value: ' \t ', base: ' \t ', explicit: true },
  { label: 'slash', value: '/', base: APP_BASE, explicit: false },
  { label: 'valid synthetic origin', value: API, base: API, explicit: true },
  { label: 'one trailing slash', value: `${API}/`, base: API, explicit: true },
  { label: 'two trailing slashes', value: `${API}//`, base: `${API}/`, explicit: true },
  { label: 'padded synthetic origin', value: `  ${API}/  `, base: `  ${API}/  `, explicit: true },
];
for (const row of apiCases) {
  test(`Negis API URL reader: ${row.label}`, async () => {
    const env = override(configured, 'VITE_API_BASE_URL', row.value);
    const f = fixture('api', env);
    assert.equal(f.reader.API_BASE_URL, row.base);
    assert.equal(f.reader.apiUrl(ROUTE), `${row.base}${ROUTE}`);
    assert.equal(f.reader.apiUrl(ROUTE.slice(1)), `${row.base}${ROUTE}`);
    assert.equal(f.reader.publicApiUrl(ROUTE),
      `${row.explicit ? row.base : BROWSER_ORIGIN + APP_BASE}${ROUTE}`);
    const response = await f.reader.crmFetch(ROUTE, { accessToken: SESSION.access_token, cache: 'no-store' });
    assert.equal(response.status, 200);
    assert.deepEqual(f.requests.map(request => request.url), [`${row.base}${ROUTE}`]);
    assert.deepEqual(f.imports, []);
  });
}

for (const row of [
  { label: 'unset', value: undefined, base: '' },
  { label: 'empty', value: '', base: '' },
  { label: 'whitespace', value: ' \t ', base: ' \t ' },
  { label: 'slash', value: '/', base: '' },
  { label: 'valid synthetic mount', value: `${APP_BASE}/`, base: APP_BASE },
]) {
  test(`BASE_URL fallback reader: ${row.label}`, () => {
    const env = override(override(configured, 'VITE_API_BASE_URL', undefined), 'BASE_URL', row.value);
    const f = fixture('api', env);
    assert.equal(f.reader.API_BASE_URL, row.base);
    assert.equal(f.reader.apiUrl(ROUTE), `${row.base}${ROUTE}`);
    assert.equal(f.reader.publicApiUrl(ROUTE), `${BROWSER_ORIGIN}${row.base}${ROUTE}`);
  });
}

for (const row of urlCases) {
  test(`Control API origin reader: ${row.label}`, () => {
    // A valid legacy API base is deliberately present; it is not a fallback.
    const env = override(configured, 'VITE_MEDINA_API_URL', row.value);
    const control = fixture('control', {}).reader;
    const resolved = control.resolveControlConfig(env);
    assert.equal(resolved.ready, row.control);
    if (resolved.ready) assert.equal(resolved.apiOrigin, DATABASE);
    else assert.deepEqual({ ...control.resolveControlBrowserEnv(env) }, emptyControl);
  });
}

for (const base of ['/', `${APP_BASE}/`]) {
  for (const value of [undefined, '', '/']) {
    test(`cleared API binding ${JSON.stringify(value) ?? 'unset'} still dispatches at mount ${base}`, async () => {
      const env = override({ BASE_URL: base }, 'VITE_API_BASE_URL', value);
      const f = fixture('api', env);
      const response = await f.reader.crmFetch(ROUTE, { accessToken: SESSION.access_token, cache: 'no-store' });
      const expected = `${BROWSER_ORIGIN}${base === '/' ? '' : APP_BASE}${ROUTE}`;
      assert.equal(response.status, 200);
      assert.equal(f.requests.length, 1, 'An empty API variable is routing fallback, not disconnection');
      assert.equal(new URL(f.requests[0].url, BROWSER_ORIGIN).href, expected);
      assert.equal(f.reader.publicApiUrl(ROUTE), expected);
      assert.equal(new Headers(f.requests[0].init.headers).get('Authorization'), `Bearer ${SESSION.access_token}`);
    });
  }
}

test('missing synthetic authentication stops a request, unlike an empty API binding', async () => {
  const f = fixture('api', { BASE_URL: '/', VITE_API_BASE_URL: '' });
  await assert.rejects(f.reader.crmFetch(ROUTE, { cache: 'no-store' }), {
    status: 401, code: 'authentication_required',
  });
  assert.deepEqual(f.imports, ['@/lib/serverAuth']);
  assert.equal(f.requests.length, 0);
});

const runtimeOnly: Env = {
  BASE_URL: '/synthetic-runtime/',
  VITE_SUPABASE_URL: 'https://runtime-database.example.test',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_runtime',
  SUPABASE_ANON_KEY: 'sb_publishable_synthetic_runtime_fallback',
  VITE_API_BASE_URL: 'https://runtime-api.example.test',
  VITE_MEDINA_API_URL: 'https://runtime-control.example.test',
};

for (const reader of ['supabase', 'profile', 'api'] as const) {
  test(`${reader}: compiled browser bindings do not follow synthetic runtime bindings`, async () => {
    const browser = { ...configured };
    const code = compile(reader, browser);
    // Changing the original build object after compilation cannot rewrite it.
    Object.assign(browser, runtimeOnly);
    for (const runtime of [{ ...runtimeOnly }, {}]) {
      if (reader === 'supabase') {
        const f = fixture(reader, browser, runtime, code);
        assert.deepEqual(f.clients, [{ url: DATABASE, key: PUBLIC_KEY }]);
        Object.assign(runtime, { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' });
        assert.equal(await f.reader.verifyCurrentPassword('actor@example.test', 'synthetic-password'), 'ok');
        assert.equal(f.requests[0].url, `${DATABASE}/auth/v1/token?grant_type=password`);
      } else if (reader === 'profile') {
        await checkProfile(browser, DATABASE, PUBLIC_KEY, runtime, code);
      } else {
        const f = fixture(reader, browser, runtime, code);
        runtime.VITE_API_BASE_URL = '';
        await f.reader.crmFetch(ROUTE, { accessToken: SESSION.access_token, cache: 'no-store' });
        assert.equal(f.reader.API_BASE_URL, API);
        assert.equal(f.requests[0].url, `${API}${ROUTE}`);
      }
    }
    // A new explicit browser transformation, not a runtime mutation, changes it.
    if (reader === 'supabase') {
      const f = fixture(reader, runtimeOnly, configured);
      assert.deepEqual(f.clients, [{ url: runtimeOnly.VITE_SUPABASE_URL, key: runtimeOnly.VITE_SUPABASE_ANON_KEY }]);
    } else if (reader === 'profile') {
      await checkProfile(runtimeOnly, runtimeOnly.VITE_SUPABASE_URL!, runtimeOnly.VITE_SUPABASE_ANON_KEY!, configured);
    } else {
      assert.equal(fixture(reader, runtimeOnly, configured).reader.API_BASE_URL, runtimeOnly.VITE_API_BASE_URL);
    }
  });

  test(`${reader}: runtime-only values cannot fill absent browser bindings`, async () => {
    if (reader === 'supabase') {
      const f = fixture(reader, {}, runtimeOnly);
      assert.equal(f.reader.hasSupabaseFrontendEnv, false);
      assert.deepEqual(f.clients, [{ url: 'https://placeholder.supabase.co', key: 'placeholder' }]);
    } else if (reader === 'profile') {
      await checkProfile({}, null, PUBLIC_KEY, runtimeOnly);
    } else {
      const f = fixture(reader, { BASE_URL: '/' }, runtimeOnly);
      assert.equal(f.reader.API_BASE_URL, '');
      assert.equal(f.reader.publicApiUrl(ROUTE), `${BROWSER_ORIGIN}${ROUTE}`);
    }
  });
}

test('Control uses its explicit input object, not implicit browser or runtime bindings', () => {
  const f = fixture('control', configured, runtimeOnly);
  assert.deepEqual({ ...f.reader.resolveControlConfig(configured) }, {
    ready: true, apiOrigin: API, supabaseUrl: DATABASE, anonKey: PUBLIC_KEY,
  });
  assert.deepEqual({ ...f.reader.resolveControlConfig(runtimeOnly) }, {
    ready: true, apiOrigin: runtimeOnly.VITE_MEDINA_API_URL,
    supabaseUrl: runtimeOnly.VITE_SUPABASE_URL, anonKey: runtimeOnly.VITE_SUPABASE_ANON_KEY,
  });
  assert.equal(f.reader.resolveControlConfig({}).ready, false);
  assert.deepEqual(f.imports, []);
  assert.equal(f.requests.length, 0);
});

test('Control public API variable does not configure the distinct Negis API base variable', async () => {
  const control = fixture('control', {}).reader;
  const browser = control.resolveControlBrowserEnv(configured);
  assert.equal(browser.VITE_MEDINA_API_URL, API);
  assert.equal(Object.hasOwn(browser, 'VITE_API_BASE_URL'), false);
  const api = fixture('api', { ...browser, BASE_URL: '/' });
  await api.reader.crmFetch(ROUTE, { accessToken: SESSION.access_token, cache: 'no-store' });
  assert.equal(api.reader.API_BASE_URL, '');
  assert.equal(new URL(api.requests[0].url, BROWSER_ORIGIN).href, `${BROWSER_ORIGIN}${ROUTE}`);
});

test('blank Control projection is not a general shared-browser API disconnect switch', async () => {
  const control = fixture('control', {}).reader;
  const browser = control.resolveControlBrowserEnv(override(configured, 'VITE_MEDINA_API_URL', ''));
  assert.deepEqual({ ...browser }, emptyControl);
  assert.equal(fixture('supabase', browser).reader.hasSupabaseFrontendEnv, false);
  await checkProfile(browser, null);
  const api = fixture('api', { ...browser, BASE_URL: '/' });
  await api.reader.crmFetch(ROUTE, { accessToken: SESSION.access_token, cache: 'no-store' });
  assert.equal(api.requests.length, 1);
  assert.equal(new URL(api.requests[0].url, BROWSER_ORIGIN).href, `${BROWSER_ORIGIN}${ROUTE}`);
});

for (const mode of [undefined, '', ' \t ', '/', 'isolated-preview']) {
  test(`Control mode ${JSON.stringify(mode) ?? 'unset'} with synthetic origins`, () => {
    const env = override(configured, 'VITE_MEDINA_CONTROL_MODE', mode);
    const control = fixture('control', {}).reader;
    const expected = mode === undefined || mode === '' || mode === ' \t ';
    assert.equal(control.resolveControlConfig(env).ready, expected);
    if (!expected) assert.deepEqual({ ...control.resolveControlBrowserEnv(env) }, emptyControl);
  });
}

test('Control development accepts explicit synthetic loopback config, not ordinary external origins', () => {
  const control = fixture('control', {}).reader;
  assert.equal(control.resolveControlConfig(configured, true).ready, false);
  const local = { ...configured, VITE_MEDINA_API_URL: ' http://127.0.0.1:43181/ ',
    VITE_SUPABASE_URL: ' http://localhost:43182/ ' };
  assert.deepEqual({ ...control.resolveControlConfig(local, true) }, {
    ready: true, apiOrigin: 'http://127.0.0.1:43181',
    supabaseUrl: 'http://localhost:43182', anonKey: PUBLIC_KEY,
  });
});
