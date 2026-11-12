import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeSqlAcl, assertNoBrowserFunctionGrants, sameSqlObject } from "./sql-acl-verifier";

const allowed = [
  "grant execute on function public.protect_ticket(public.receipt) to service_role;",
  "grant execute on function public.function_to_review(uuid), public.other(public.receipt, text[]) to service_role;",
  'GRANT EXECUTE ON FUNCTION "public"."function_to_review"(uuid), public.other() TO "service_role" WITH GRANT OPTION;',
  "grant all privileges on all functions in schema public to other_service_role;",
  "grant execute on function public.public_type(public.authenticated_type) to anonymous, authenticated_extra, other_public;",
  "grant execute on function public.f(uuid) to service_role, \"service_role_extra\";",
  "/* grant execute on function public.f() to anon; /* nested */ */ select 'grant execute on function public.f() to anon;';",
  'grant execute on function public."to"(public."anon") to "ANON";',
  "grant execute on function public.f() to service_role; -- to public;",
  "do $body$ begin execute 'grant execute on function public.f() to service_role;'; end $body$;",
  "do $$ begin execute format('grant execute on function public.f() to service_role'); end $$;",
  "create function public.f() returns text language sql as $$ select 'grant execute on function public.f() to anon;'; $$;",
];

test("only exact reviewed 116 can use parameter-bound appointment DML, without weakening ACL parsing", async () => {
  const source = await readFile(new URL("../../migrations/116_appointment_patch_actor.sql", import.meta.url), "utf8");
  assert.doesNotThrow(() => assertNoBrowserFunctionGrants(source));
  assert.equal(analyzeSqlAcl(source).acls.filter(acl => acl.action === "grant").length, 1);
  for (const modified of [source + "\ngrant execute on function public.f() to anon;",
    source.replace("assignments||", "untrusted_assignment||"),
    source.replace("where workspace_id=$2 and id=$3", "where id=$3"),
    source.replace("using next_row,p_workspace_id,p_appointment_id", "using forged_row,p_workspace_id,p_appointment_id")]) {
    assert.notEqual(modified, source);
    assert.throws(() => assertNoBrowserFunctionGrants(modified));
  }
});

for (const [index, sql] of allowed.entries()) {
  test(`ACL accepts statically established non-browser recipients ${index + 1}`, () => {
    assert.doesNotThrow(() => assertNoBrowserFunctionGrants(sql));
  });
}

const denied = [
  "grant execute on function public.protect_ticket(public.receipt) to anon;",
  "grant execute on function public.function_to_review(public.receipt), public.other(uuid) to authenticated;",
  'grant execute on function public.f() to "anon";',
  'grant execute on function public.f() to "authenticated" with grant option;',
  "grant execute on function public.f() to service_role, public;",
  "grant execute on all functions in schema public to anon;",
  "grant all privileges on function public.f() to authenticated;",
  "grant all on all routines in schema public to public;",
  "grant execute on procedure public.f(uuid) to anon;",
  "grant execute on routine public.f(uuid) to public;",
  "grant execute on function public.f(public.receipt), public.f(uuid) to group anon;",
  "grant execute on function public.f() to current_user;",
  "grant execute on function public.f() to current_role;",
  "grant execute on function public.f() to session_user;",
  "grant execute on function public.f() to service_role extra;",
  "grant execute on function public.f() to service_role with unknown option;",
  "grant execute on function public.f(public.receipt) service_role;",
  "grant execute on function public.f(public.receipt), to service_role;",
  "grant service_role to authenticated;",
  "do $$ begin execute 'grant execute on function public.f() to anon;'; end $$;",
  "do $$ begin execute format('grant execute on function public.f() to %I', role_name); end $$;",
  "do $$ begin execute format('grant execute on function %s to service_role', function_name); end $$;",
  "do $$ begin execute 'gr' || 'ant execute on function public.f() to anon'; end $$;",
  "do $$ begin execute sql_variable; end $$;",
  "do $$ begin execute make_acl(); end $$;",
  "do $$ begin execute format(template, function_name); end $$;",
  "do $$ begin execute $acl$grant execute on function public.f() to anon;$acl$; end $$;",
  "create function public.f() returns void language plpgsql as $$ begin grant execute on function public.f() to anon; end $$;",
  String.raw`do $$ begin execute E'gr\x61nt execute on function public.f() to anon;'; end $$;`,
  String.raw`do $$ begin execute E'gr\141nt execute on function public.f() to anon;'; end $$;`,
  String.raw`do $$ begin execute E'gr\u0061nt execute on function public.f() to anon;'; end $$;`,
  "create function public.f() returns void language plpgsql as 'begin grant execute on function public.f() to anon; end';",
  "do 'begin grant execute on function public.f() to anon; end';",
  'alter default privileges in schema public grant execute on functions to "authenticated";',
];

for (const [index, sql] of denied.entries()) {
  test(`ACL rejects browser or unverifiable recipients ${index + 1}`, () => {
    assert.throws(() => assertNoBrowserFunctionGrants(sql));
  });
}

test("088 overload/type-qualified arguments are not GRANT recipients", async () => {
  const source = await readFile(new URL("../../migrations/088_staged_creative_workflow.sql", import.meta.url), "utf8");
  assert.doesNotThrow(() => assertNoBrowserFunctionGrants(source));
  const grants = analyzeSqlAcl(source).acls.filter((acl) => acl.action === "grant" && acl.kind === "function");
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].roles, ["service_role"]);
  assert.equal(grants[0].objects.length, 6);
  assert.deepEqual(grants[0].objects[2], { schema: "public", name: "creative_upload_ticket", args: ["public.creative_upload_operations"] });
});

test("084 list grants and whitespace retain all three exact RPC signatures", async () => {
  const source = await readFile(new URL("../../migrations/084_platform_subscription_operations.sql", import.meta.url), "utf8");
  const analysis = analyzeSqlAcl(source);
  const grants = analysis.acls.filter((acl) => acl.action === "grant" && acl.kind === "function");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].objects.length, 3);
  assert.deepEqual(grants[0].roles, ["service_role"]);
  assert.equal(analysis.functions.filter((fn) => fn.definer && fn.emptySearchPath).length, 3);
  assert.equal(analysis.functions[0].definer, false, "the receipt helper is not a reviewed SECURITY DEFINER RPC");
});

test("090 catalog-derived signatures have a bounded positive proof, not a filename exception", async () => {
  const source = await readFile(new URL("../../migrations/090_generated_video_workflow.sql", import.meta.url), "utf8");
  const analysis = analyzeSqlAcl(source);
  const grant = analysis.acls.find((acl) => acl.action === "grant" && acl.kind === "function");
  assert.ok(grant);
  assert.equal(grant.objects.length, 13);
  assert.deepEqual(grant.roles, ["service_role"]);
  assert.doesNotThrow(() => assertNoBrowserFunctionGrants(source));
  for (const [before, after] of [
    ["p.oid::regprocedure as signature", "p.proname::text as signature"],
    ["from pg_proc p join", "from app_provided_signatures p join"],
    ["execute format('grant execute", "f.signature := 'public.f() to anon; --'; execute format('grant execute"],
    ["grant execute on function %s to service_role", "grant execute on function %s to %s"],
    ["from public,anon,authenticated',f.signature", "from public,anon,authenticated',untrusted_signature"],
    ["'assert_generated_video_actor','protect_generated_video_workflow'", "'unreviewed_external_function','protect_generated_video_workflow'"],
  ]) {
    assert.ok(source.includes(before), before);
    assert.throws(() => analyzeSqlAcl(source.replace(before, after)), after);
  }
});

test("list targets, quoted recipients and column privileges preserve exact boundaries", () => {
  const { acls } = analyzeSqlAcl('grant select(id), update(value) on table public.first, "public"."second" to "service_role", reader with grant option;');
  assert.deepEqual(acls[0].roles, ["service_role", "reader"]);
  assert.deepEqual(acls[0].privileges, ["select", "update"]);
  assert.deepEqual(acls[0].objects, [{ schema: "public", name: "first" }, { schema: "public", name: "second" }]);
  assert.equal(acls[0].grantOption, true);
  assert.equal(sameSqlObject(acls[0].objects[1], { schema: "public", name: "secon" }), false);
  assert.equal(sameSqlObject(acls[0].objects[1], { schema: "other", name: "second" }), false);
});

test("REVOKE lists do not prove EXECUTE removal when only the grant option is revoked", () => {
  const { acls } = analyzeSqlAcl('revoke grant option for execute on function public.f(uuid), public.f(text) from "public", anon, authenticated cascade;');
  assert.equal(acls[0].optionOnly, true);
  assert.equal(acls[0].objects.length, 2);
  assert.deepEqual(acls[0].roles, ["public", "anon", "authenticated"]);
});

test("SECURITY DEFINER and empty search_path are proved per exact function, never by neighbors or comments", () => {
  const { functions } = analyzeSqlAcl(`
    create function public.safe(p_id uuid) returns void language plpgsql security definer set search_path='' as $$ begin perform public.receipts; end $$;
    create function public.unsafe(p_id uuid) returns void language plpgsql security invoker as $$ begin perform public.receipts; end $$;
    create function public.path(p_id uuid) returns void language plpgsql security definer set search_path=public as $$ begin perform public.receipts; end $$;
    create function public.prose(p_id uuid) returns text language sql security definer set search_path='' as $$ select 'public.receipts'; $$;
    create function public.mixed(p_id uuid) returns text language sql security definer set search_path='',public as $$ select 'public.receipts'; $$;
  `);
  assert.deepEqual(functions.map((fn) => [fn.object.name, fn.definer, fn.emptySearchPath]), [
    ["safe", true, true], ["unsafe", false, false], ["path", true, false], ["prose", true, true], ["mixed", true, false],
  ]);
  assert.deepEqual(functions[0].object.args, ["uuid"]);
  assert.deepEqual(functions[0].references, [{ schema: "public", name: "receipts" }]);
  assert.deepEqual(functions[3].references, []);
});

test("RLS/policy evidence is attached to the actual table, not prose or a similarly named relation", () => {
  const { rls, policies } = analyzeSqlAcl(`
    alter table only public.receipts enable row level security;
    alter table if exists "public"."receipts" disable row level security;
    create policy exposure on public.receipts to authenticated using (true);
    select 'alter table public.other enable row level security';
  `);
  assert.deepEqual(rls, [
    { object: { schema: "public", name: "receipts" }, enabled: true },
    { object: { schema: "public", name: "receipts" }, enabled: false },
  ]);
  assert.deepEqual(policies, [{ schema: "public", name: "receipts" }]);
});

test("receipt trigger contracts retain UPDATE coverage, deferred checks, and later disable/drop evidence", async () => {
  const source = await readFile(new URL("../../migrations/093_site_consent_receipts.sql", import.meta.url), "utf8");
  const analysis = analyzeSqlAcl(source);
  assert.deepEqual(analysis.triggers.map((trigger) => [trigger.name, trigger.events, trigger.row, trigger.deferred]), [
    ["guard_crm_site_consent_receipt", ["insert", "update"], true, false],
    ["guard_crm_site_inquiry_binding", ["update"], true, false],
    ["require_crm_site_consent_receipt", ["insert"], true, true],
  ]);
  const changed = analyzeSqlAcl(`alter table public.crm_site_consent_receipts disable trigger guard_crm_site_consent_receipt;
    drop trigger if exists require_crm_site_consent_receipt on public.crm_site_inquiries;`);
  assert.deepEqual(changed.triggerEdits, [
    { object: { schema: "public", name: "crm_site_consent_receipts" }, name: "guard_crm_site_consent_receipt" },
    { object: { schema: "public", name: "crm_site_inquiries" }, name: "require_crm_site_consent_receipt" },
  ]);
});
