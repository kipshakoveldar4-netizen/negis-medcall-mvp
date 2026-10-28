import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ORIGIN, ENTRY_ACTOR, ENTRY_OTHER } from './partner-entry-http-fixture.mjs';
after(stopPartnerEntryBuilds);
function adapter() {
  const calls = [], saved = new Map(), controls = { malformed: false, error: null };
  return { calls, saved, controls, async rpc(name, args) {
    calls.push({ name, args: structuredClone(args) }); if (controls.error) return { data: null, error: { code: controls.error, message: 'PRIVATE_DB_DIAGNOSTIC' } };
    if (controls.malformed) return { data: { state: 'unconfirmed' }, error: null };
    let v = saved.get(args.p_intent);
    if (name === 'capture_growth_partner_source_v2') {
      if (!v) { v = { id: args.p_intent, capturedAt: args.p_started_at.replace('Z','000Z'), expiresAt: new Date(Date.parse(args.p_started_at)+7*86400000).toISOString().replace('Z','000Z'),
        policyVersion: '2026-10-27-7d-self-v1', state: 'captured', source: args.p_source, workspaceId: null, actor: null }; saved.set(args.p_intent,v); }
      return { data: { id: v.id, capturedAt: v.capturedAt, expiresAt: v.expiresAt, policyVersion: v.policyVersion }, error: null };
    }
    if (name === 'claim_growth_partner_source') { if (!v || v.actor && v.actor !== args.p_actor) return { data: null, error: { code: 'P1121' } }; v.actor = args.p_actor; }
    else assert.equal(name,'read_growth_partner_source');
    if (!v) return { data: { state: 'unconfirmed' }, error: null };
    if (v.actor !== args.p_actor) return { data: null, error: { code: 'P1121' } };
    const { actor, ...data } = v; return { data, error: null };
  } };
}
function res() { return { statusCode: 200, headers: {}, body: null, setHeader(k,v) { this.headers[k.toLowerCase()]=v; return this; },
  status(v) { this.statusCode=v; return this; }, json(v) { this.body=v; return this; }, end(v) { this.body=v; return this; } }; }
async function call(f, op, body = {}, options = {}) {
  const raw = options.raw ?? JSON.stringify(body), req = Readable.from([Buffer.from(raw)]);
  Object.assign(req, { url: '/api/crm/partner-entry?op='+op, method: options.method ?? 'POST', query: { path: ['partner-entry'], op, ...options.query },
    headers: { origin: ENTRY_ORIGIN, 'content-type': 'application/json', ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.token ? { authorization: 'Bearer '+options.token } : {}), ...options.headers } });
  const response = res(); await f.handler(req, response); assert.deepEqual(f.state.unexpected, []); assert.equal(response.headers['cache-control'],'no-store');
  for (const marker of ['PRIVATE_', f.env.MEDINA_PARTNER_ENTRY_COOKIE_KEY, f.env.MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET, 'owned-only-not-credential'].filter(v=>typeof v==='string'&&v.length)) assert.ok(!JSON.stringify(response.body).includes(marker));
  return response;
}
const prepareBody = { code: 'CODE_A', source: 'link', consent: true, consentVersion: 'owned-partner-v1', challengeToken: 'owned-challenge' };
async function prepare(f, options = {}) { const r=await call(f,'prepare',prepareBody,options); assert.equal(r.statusCode,200); return r.headers['set-cookie']?.split(';')[0] ?? options.cookie; }

test('reserved company remains pending payment, and an expired reserved source is not reported as bound',async()=>{
  const db=adapter(),f=await partnerEntryHttpFixture(db);try{
    const cookie=await prepare(f),options={cookie,token:'owned.owner.signature'};
    await call(f,'capture',{},options);await call(f,'claim',{},options);
    const value=[...db.saved.values()][0];value.workspaceId=ENTRY_OTHER;
    for(const state of ['pending_payment','expired','bound']){
      value.state=state;const r=await call(f,'read',{},options);assert.equal(r.statusCode,200);assert.equal(r.body.data.state,state);assert.equal(r.body.data.workspaceId,ENTRY_OTHER);
    }
    value.state='pending_payment';value.workspaceId=null;assert.equal((await call(f,'read',{},options)).statusCode,503);
    value.state='captured';value.workspaceId=ENTRY_OTHER;assert.equal((await call(f,'read',{},options)).statusCode,503);
  }finally{f.close();}
});

test('actual router has no enabled gateway without explicit config AND approved notice', async () => {
  for (const options of [{ approved: false }, { env: { MEDINA_PARTNER_ENTRY_ENABLED: 'false' } }, { env: { MEDINA_PARTNER_ENTRY_COOKIE_KEY: '' } }]) {
    const db=adapter(), f=await partnerEntryHttpFixture(db,options); try { const r=await call(f,'prepare',prepareBody); assert.equal(r.statusCode,503); assert.equal(r.headers['set-cookie'],undefined); assert.equal(db.calls.length,0); assert.equal(f.state.challenges.length,0); } finally { f.close(); }
  }
});
test('real consent registry, origin, exact query, methods and body limits precede providers and writes', async () => {
  const db=adapter(),f=await partnerEntryHttpFixture(db); try {
    const notice=await call(f,'notice'); assert.equal(notice.statusCode,200); assert.equal(notice.body.data.notice.sha256,f.notice.sha256);
    assert.equal((await call(f,'prepare',prepareBody,{headers:{origin:'https://foreign.fixture.invalid'}})).statusCode,403);
    assert.equal((await call(f,'prepare',prepareBody,{query:{workspaceId:ENTRY_ACTOR}})).statusCode,400);
    assert.equal((await call(f,'prepare',prepareBody,{method:'GET'})).statusCode,405);
    assert.equal((await call(f,'prepare',{}, {raw:'{bad'})).statusCode,400);
    assert.equal((await call(f,'prepare',{}, {raw:' '.repeat(8193)})).statusCode,413);
    for (const body of [{...prepareBody,consent:false},{...prepareBody,consentVersion:'unknown'},{...prepareBody,actor:ENTRY_OTHER},{...prepareBody,startedAt:'2020-01-01'}])
      assert.equal((await call(f,'prepare',body)).statusCode,400);
    for(const source of [null,{},['link'],{toString:'private-object'},1,true])assert.equal((await call(f,'prepare',{...prepareBody,source})).statusCode,400);
    assert.equal(db.calls.length,0); assert.equal(f.state.challenges.length,0);
  } finally { f.close(); }
});
test('local circuit breaker rejects excess requests before Auth/provider/SQL without claiming distributed protection', async()=>{
  const db=adapter(),f=await partnerEntryHttpFixture(db);try{
    for(let n=0;n<60;n++)assert.equal((await call(f,'notice')).statusCode,200);
    const r=await call(f,'claim',{}, {token:'owned.owner.signature'});assert.equal(r.statusCode,429);assert.equal(f.state.auth.length,0);assert.equal(db.calls.length,0);
  }finally{f.close();}
});
test('hostname/action/status/size failures cannot mint a cookie; provider data stays private', async () => {
  for (const mode of ['hostname','action','status','size','malformed']) {
    const f=await partnerEntryHttpFixture(adapter()); try {
      if (mode==='hostname') f.state.challenge.hostname='foreign.fixture.invalid'; if(mode==='action')f.state.challenge.action='site_inquiry';
      if(mode==='status') f.state.challengeStatus=503; if(mode==='size')f.state.challengeBytes=' '.repeat(8193); if(mode==='malformed')f.state.challengeBytes='PRIVATE_JSON_FAILURE';
      const r=await call(f,'prepare',prepareBody); assert.equal(r.statusCode,403,mode); assert.equal(r.headers['set-cookie'],undefined);
    } finally { f.close(); }
  }
});
test('prepared first-source cookie is sealed, origin-bound, seven-day, HttpOnly and never returned in JSON', async () => {
  const db=adapter(),f=await partnerEntryHttpFixture(db); try {
    const cookie=await prepare(f); const raw=await call(f,'prepare',{...prepareBody,code:'CODE_B'},{cookie});
    assert.equal(raw.statusCode,200); assert.equal(raw.headers['set-cookie'],undefined); assert.equal(f.state.challenges.length,1); assert.equal(db.calls.length,0);
    const frame=f.cookies.readPartnerEntryCookie(cookie,ENTRY_ORIGIN,Buffer.from('ab'.repeat(32),'hex'),Date.now()); assert.equal(frame.state,'valid'); assert.equal(frame.frame.code,'CODE_A');
    assert.equal(Date.parse(raw.body.data.expiresAt)-Date.parse(frame.frame.startedAt),7*86400000);
    const header=f.cookies.partnerEntrySetCookie(frame.frame,ENTRY_ORIGIN,Buffer.from('ab'.repeat(32),'hex'),Date.now());
    assert.match(header,/Secure; HttpOnly; SameSite=Lax/); assert.match(header,/Path=\/api\/crm\/partner-entry/); assert.doesNotMatch(header,/Domain=/);
    assert.ok(!JSON.stringify(raw.body).includes(frame.frame.token));
    assert.equal(f.cookies.readPartnerEntryCookie(cookie,'https://other.fixture.invalid',Buffer.from('ab'.repeat(32),'hex'),Date.now()).state,'invalid');
  } finally { f.close(); }
});
test('capture uses only the sealed frame; read/claim take identity only from real verified Auth', async () => {
  const db=adapter(),f=await partnerEntryHttpFixture(db); try {
    const cookie=await prepare(f); assert.equal((await call(f,'capture',{}, {cookie})).statusCode,200);
    assert.equal((await call(f,'claim',{}, {cookie})).statusCode,401);
    assert.equal((await call(f,'claim',{actor:ENTRY_OTHER},{cookie,token:'owned.owner.signature'})).statusCode,400);
    assert.equal((await call(f,'claim',{}, {cookie,token:'owned.owner.signature'})).statusCode,200);
    assert.equal(db.calls.at(-1).args.p_actor,ENTRY_ACTOR);
    assert.equal((await call(f,'read',{}, {cookie,token:'owned.other.signature'})).statusCode,403);
    assert.equal((await call(f,'read',{}, {cookie,token:'owned.owner.signature'})).statusCode,200);
    assert.equal(db.calls[0].name,'capture_growth_partner_source_v2'); assert.deepEqual(Object.keys(db.calls[0].args).sort(),['p_intent','p_capability_hash','p_code','p_source','p_started_at'].sort());
  } finally { f.close(); }
});
test('tampering, duplicate cookies and expiry stop before SQL and cannot silently issue a fresh window', async () => {
  const db=adapter(),f=await partnerEntryHttpFixture(db); try {
    const cookie=await prepare(f);
    for(const bad of [cookie+'a',cookie+'; '+cookie,'__Secure-medina_partner_entry=garbage'])assert.equal((await call(f,'capture',{}, {cookie:bad})).statusCode,400);
    const old=f.cookies.newPartnerEntryFrame('CODE_A','link',f.notice.version,f.notice.sha256,Date.now()-8*86400000);
    const expired='__Secure-medina_partner_entry='+f.cookies.sealPartnerEntry(old,ENTRY_ORIGIN,Buffer.from('ab'.repeat(32),'hex'));
    assert.equal((await call(f,'capture',{}, {cookie:expired})).statusCode,410);
    assert.equal((await call(f,'prepare',prepareBody, {cookie:expired})).statusCode,410); assert.equal(db.calls.length,0);
  } finally { f.close(); }
});
test('malformed mutation acknowledgements are not success; later reads can recover without a second capture', async () => {
  const db=adapter(),f=await partnerEntryHttpFixture(db); try {
    const cookie=await prepare(f); await call(f,'capture',{}, {cookie}); db.controls.malformed=true;
    assert.equal((await call(f,'claim',{}, {cookie,token:'owned.owner.signature'})).statusCode,503);
    db.controls.malformed=false; assert.equal((await call(f,'claim',{}, {cookie,token:'owned.owner.signature'})).statusCode,200);
    assert.equal((await call(f,'read',{}, {cookie,token:'owned.owner.signature'})).statusCode,200);
    assert.equal(db.calls.filter(v=>v.name==='capture_growth_partner_source_v2').length,1);
  } finally { f.close(); }
});
