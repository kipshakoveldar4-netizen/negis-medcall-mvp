export type PartnerTermsAction = "offer" | "cancel" | "accept" | "decline";
export type PartnerOffer = { firstCommissionBps: number; renewalCommissionBps: number; terms: string };
export type PartnerAgreement = PartnerOffer & { revision: string; state: "pending" | "accepted" | "declined" | "cancelled";
  offeredAt: string; decidedAt: string | null; commercialStatus: "active" | "suspended" | null; referralCode: string | null };
export type PartnerTermsSnapshot = { profileId: string; profileRevision: string } & (
  { state: "not_offered" | "legacy_unmanaged"; agreement: null } | { state: "managed"; agreement: PartnerAgreement });
export type PartnerTermsCommand = { requestId: string; profileId: string; profileRevision: string; revision: string | null;
  action: PartnerTermsAction; payload: PartnerOffer | { accepted: true } | Record<string, never> };
export type PartnerTermsReceipt = { requestId: string; profileId: string } & (
  { state: "unconfirmed" } | { state: "abandoned"; action: PartnerTermsAction }
  | { state: "committed"; action: PartnerTermsAction; result: PartnerTermsSnapshot });
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v,k));
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const rate = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const action = (v: unknown): v is PartnerTermsAction => typeof v === "string" && ["offer","cancel","accept","decline"].includes(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,19) === v.slice(0,19);
// Validated UTC strings retain SQL microseconds, unlike Date's millisecond clock.
const instantKey = (value: string) => { const [second,fraction=""] = value.slice(0,-1).split("."); return second+"."+fraction.padEnd(6,"0"); };
export function parsePartnerOffer(value: unknown): PartnerOffer | null {
  const v = object(value);
  return v && keys(v,["firstCommissionBps","renewalCommissionBps","terms"]) && rate(v.firstCommissionBps,1000,5000)
    && rate(v.renewalCommissionBps,500,1000) && typeof v.terms === "string" && v.terms.trim().length>0 && v.terms.length<=2000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.terms)
    ? { firstCommissionBps:v.firstCommissionBps,renewalCommissionBps:v.renewalCommissionBps,terms:v.terms } : null;
}
export function parsePartnerTermsSnapshot(value: unknown): PartnerTermsSnapshot | null {
  const v=object(value);
  if (!v || !keys(v,["profileId","profileRevision","state","agreement"]) || !uuid(v.profileId) || !uuid(v.profileRevision)) return null;
  if ((v.state==="not_offered" || v.state==="legacy_unmanaged") && v.agreement===null)
    return {profileId:v.profileId,profileRevision:v.profileRevision,state:v.state,agreement:null};
  const a=object(v.agreement);
  if (v.state!=="managed" || !a || !keys(a,["revision","state","firstCommissionBps","renewalCommissionBps","terms","offeredAt","decidedAt","commercialStatus","referralCode"])
    || !uuid(a.revision) || typeof a.state!=="string" || !["pending","accepted","declined","cancelled"].includes(a.state) || !instant(a.offeredAt)) return null;
  const offer=parsePartnerOffer({firstCommissionBps:a.firstCommissionBps,renewalCommissionBps:a.renewalCommissionBps,terms:a.terms});
  if (!offer || (a.state==="pending" ? a.decidedAt!==null : !instant(a.decidedAt) || instantKey(a.decidedAt)<instantKey(a.offeredAt))) return null;
  if (a.state==="accepted" ? typeof a.commercialStatus!=="string" || !["active","suspended"].includes(a.commercialStatus)
    || (a.commercialStatus==="active" ? typeof a.referralCode!=="string" || !/^[A-F0-9]{32}$/.test(a.referralCode) : a.referralCode!==null)
    : a.commercialStatus!==null || a.referralCode!==null) return null;
  return {profileId:v.profileId,profileRevision:v.profileRevision,state:"managed",agreement:{...offer,revision:a.revision,
    state:a.state as PartnerAgreement["state"],offeredAt:a.offeredAt,decidedAt:a.decidedAt as string|null,
    commercialStatus:a.commercialStatus as PartnerAgreement["commercialStatus"],referralCode:a.referralCode as string|null}};
}
export function parsePartnerTermsCommand(value: unknown): PartnerTermsCommand | null {
  const v=object(value),p=object(v?.payload);
  if (!v || !p || !keys(v,["requestId","profileId","profileRevision","revision","action","payload"])
    || !uuid(v.requestId) || !uuid(v.profileId) || !uuid(v.profileRevision) || (v.revision!==null&&!uuid(v.revision)) || !action(v.action)) return null;
  const offer=v.action==="offer"?parsePartnerOffer(p):null;
  if (v.action==="offer" ? !offer : v.revision===null || (v.action==="accept" ? !keys(p,["accepted"]) || p.accepted!==true : !keys(p,[]))) return null;
  return {requestId:v.requestId,profileId:v.profileId,profileRevision:v.profileRevision,revision:v.revision,action:v.action,
    payload:offer ?? (v.action==="accept"?{accepted:true}:{})};
}
export function parsePartnerTermsReceipt(value: unknown): PartnerTermsReceipt | null {
  const v=object(value);if (!v || !uuid(v.requestId) || !uuid(v.profileId)) return null;
  if (v.state==="unconfirmed" && keys(v,["state","requestId","profileId"])) return {state:v.state,requestId:v.requestId,profileId:v.profileId};
  if (!action(v.action)) return null;
  if (v.state==="abandoned" && keys(v,["state","requestId","profileId","action"])) return {state:v.state,requestId:v.requestId,profileId:v.profileId,action:v.action};
  const snapshot=parsePartnerTermsSnapshot(v.result),expected={offer:"pending",accept:"accepted",cancel:"cancelled",decline:"declined"};
  if (v.state!=="committed" || !keys(v,["state","requestId","profileId","action","result"]) || !snapshot
    || snapshot.profileId.toLowerCase()!==v.profileId.toLowerCase() || snapshot.state!=="managed" || snapshot.agreement.state!==expected[v.action]) return null;
  return {state:"committed",requestId:v.requestId,profileId:v.profileId,action:v.action,result:snapshot};
}
