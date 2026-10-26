export type PartnerLedger = { state: "not_activated" | "suspended" } | {
  state: "ready"; generatedAt: string; firstCommissionBps: number | null; renewalCommissionBps: number | null;
  registrations: string; paidCompanies: string; firstPayments: string; renewals: string;
  balances: { currency: string; earnedMinor: string; paidMinor: string; availableMinor: string }[];
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const natural = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d{0,63})$/.test(value);
const rate = (value: unknown, min: number, max: number): value is number | null => value === null
  || typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
function instant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,19) === value.slice(0,19);
}
export function parsePartnerLedger(value: unknown): PartnerLedger | null {
  const row = record(value);
  if (!row) return null;
  if (row.state === "not_activated" || row.state === "suspended")
    return Object.keys(row).length === 1 ? { state: row.state } : null;
  if (row.state !== "ready" || !instant(row.generatedAt) || !rate(row.firstCommissionBps,1000,5000)
    || !rate(row.renewalCommissionBps,500,1000) || !natural(row.registrations) || !natural(row.paidCompanies)
    || !natural(row.firstPayments) || !natural(row.renewals) || !Array.isArray(row.balances) || row.balances.length>256) return null;
  const registered=BigInt(row.registrations),paid=BigInt(row.paidCompanies),first=BigInt(row.firstPayments),renewals=BigInt(row.renewals);
  if (paid>registered || first>paid || first+renewals<paid || (paid===0n && first+renewals!==0n)) return null;
  const balances: Extract<PartnerLedger,{state:"ready"}>["balances"]=[], currencies=new Set<string>();
  for (const value of row.balances) {
    const b=record(value);
    if (!b || typeof b.currency!=="string" || !/^[A-Z]{3}$/.test(b.currency) || currencies.has(b.currency)
      || !natural(b.earnedMinor) || !natural(b.paidMinor) || !natural(b.availableMinor)
      || BigInt(b.earnedMinor)!==BigInt(b.paidMinor)+BigInt(b.availableMinor)) return null;
    currencies.add(b.currency); balances.push({currency:b.currency,earnedMinor:b.earnedMinor,paidMinor:b.paidMinor,availableMinor:b.availableMinor});
  }
  if ((paid===0n)!==(balances.length===0)) return null;
  return {state:"ready",generatedAt:row.generatedAt,firstCommissionBps:row.firstCommissionBps,renewalCommissionBps:row.renewalCommissionBps,
    registrations:row.registrations,paidCompanies:row.paidCompanies,firstPayments:row.firstPayments,renewals:row.renewals,balances};
}
