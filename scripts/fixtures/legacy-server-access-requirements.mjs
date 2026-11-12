// Fresh-source-chain requirements only. Existing Supabase/cloud grants are
// intentionally unread and unknown. This is evidence for a reviewed forward
// bootstrap repair, not a statement that a working deployment is broken.
const entry = (table, privileges, columns, routes, authority) => Object.freeze({
  table,
  privileges: Object.freeze(privileges),
  columns: Object.freeze(columns.split(',')),
  routes: Object.freeze(routes),
  authority: Object.freeze(authority),
});

export const legacyServerAccessRequirements = Object.freeze([
  entry('content_videos', ['SELECT', 'INSERT', 'UPDATE'],
    'id,workspace_id,title,niche,goal,duration,style,audience,hook,script,voiceover,cta,caption,hashtags,avatar_prompt,tapnow_prompt,status,raw_payload,created_at,updated_at',
    ['GET /api/crm/content-videos', 'POST /api/crm/content-videos', 'PATCH /api/crm/content-videos'],
    { resource: 'content-videos', source: 'lib/crm/server.ts', configLine: 2155,
      read: 'listItems', insert: 'createItem', update: 'patchItem', extraUpdate: 'persistContentVideoPatchIfAvailable' }),
  entry('meta_ad_accounts', ['SELECT', 'INSERT', 'UPDATE'],
    'id,workspace_id,meta_business_id,ad_account_id,page_id,instagram_actor_id,account_name,currency,timezone_name,status,metadata,created_at,updated_at',
    ['GET /api/crm/meta-accounts', 'POST /api/crm/meta-accounts', 'PATCH /api/crm/meta-accounts'],
    { resource: 'meta-accounts', source: 'lib/crm/server.ts', configLine: 2279,
      read: 'listItems', insert: 'createItem', update: 'patchItem',
      note: 'POST reads existing binding then inserts or updates it; router also requires provisioned workspace/ad-account guards.' }),
  entry('meta_campaign_launches', ['SELECT', 'INSERT', 'UPDATE'],
    'id,workspace_id,launched_by,launched_by_role,source_module,source_id,campaign_name,objective,status,meta_campaign_id,meta_adset_id,meta_creative_id,meta_ad_id,meta_status,budget_daily_minor,budget_total_minor,currency,start_time,end_time,page_id,instagram_actor_id,ad_account_id,payload,compliance,meta_response,last_error,created_at,updated_at',
    ['GET /api/crm/meta-launches', 'POST /api/crm/meta-launches', 'PATCH /api/crm/meta-launches', 'POST /api/crm/meta-launch'],
    { resource: 'meta-launches', source: 'lib/crm/server.ts', configLine: 2312,
      read: 'listItems', insert: 'createItem', update: 'patchItem', extraInsert: 'persistMetaLaunch' }),
  entry('meta_launch_audit_logs', ['INSERT'],
    'id,workspace_id,launch_id,actor_name,actor_role,action,details,created_at',
    ['POST /api/crm/meta-launch'],
    { source: 'lib/crm/server.ts', insert: 'insertMetaAuditLog', insertLine: 8169,
      note: 'Internal audit insert only; no generic public/resource reader, updater or deleter is inferred.' }),
  entry('release_checks', ['SELECT', 'INSERT', 'UPDATE'],
    'id,workspace_id,check_key,status,notes,checked_at,created_at,updated_at',
    ['GET /api/crm/release-checks', 'POST /api/crm/release-checks', 'PATCH /api/crm/release-checks'],
    { resource: 'release-checks', source: 'lib/crm/server.ts', configLine: 2426,
      read: 'listItems', insert: 'createItem', update: 'patchItem',
      note: 'POST uses upsert(workspace_id,check_key), requiring INSERT and UPDATE; returning rows/list requires SELECT.' }),
  entry('targeting_campaigns', ['SELECT', 'INSERT', 'UPDATE'],
    'id,workspace_id,campaign_name,niche,city,offer,budget,status,raw_payload,created_at',
    ['POST /api/targeting/launch', 'GET /api/targeting/report', 'GET /api/targeting/reports/[campaignId]'],
    { source: 'lib/targeting-agent/persistence.ts', read: 'campaignBelongsToWorkspace', insert: 'persistTargetingCampaignIfAvailable',
      update: 'persistTargetingCampaignIfAvailable', readLine: 140, writeLine: 93,
      note: 'Verified campaign id uses upsert(id); an unbound id uses insert. Report handlers check workspace ownership before calling their agent.' }),
  entry('targeting_reports', ['INSERT'],
    'id,campaign_id,summary,metrics,insights,recommendations,raw_payload,created_at',
    ['GET /api/targeting/report', 'GET /api/targeting/reports/[campaignId]'],
    { source: 'lib/targeting-agent/persistence.ts', insert: 'persistTargetingReportIfAvailable', insertLine: 182,
      note: 'Successful guarded report retrieval appends a receipt without .select(); SELECT/UPDATE/DELETE are not inferred.' }),
]);

export const legacyServerPrivilegeMatrix = Object.freeze(Object.fromEntries(
  legacyServerAccessRequirements.map(({ table, privileges }) => [table, privileges])));
