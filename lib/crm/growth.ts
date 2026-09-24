/** Money stays in minor units; JSON-facing results are decimal strings. */
export type SubscriptionPaymentKind = "first" | "renewal";

export function readMinor(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("invalid_minor_units");
  }
  return BigInt(value);
}

export function commissionMinor(amountMinor: string, rateBps: number, kind: SubscriptionPaymentKind): string {
  const minimum = kind === "first" ? 1000 : 500;
  const maximum = kind === "first" ? 5000 : 1000;
  if (!["first", "renewal"].includes(kind) || !Number.isInteger(rateBps) || rateBps < minimum || rateBps > maximum) {
    throw new Error("invalid_commission_rate");
  }
  // Same round-down rule as the SQL receipt function; no fractional minor unit.
  return (readMinor(amountMinor) * BigInt(rateBps) / 10000n).toString();
}

export type PartnerCommissionReceipt = {
  paymentId: string;
  workspaceId: string;
  kind: SubscriptionPaymentKind;
  amountMinor: string;
  currency: string;
};

export type PartnerPayoutReceipt = {
  id: string;
  amountMinor: string;
  currency: string;
};

/**
 * Input must be fully paginated and scoped to a server-verified partner.
 * A failed fetch is not an empty array. No subscription price or CRM sale is
 * accepted here: only immutable commission and completed payout receipts.
 */
export function summarizePartnerLedger(
  registeredWorkspaceIds: readonly string[],
  commissions: readonly PartnerCommissionReceipt[],
  payouts: readonly PartnerPayoutReceipt[],
) {
  const registered = new Set(registeredWorkspaceIds);
  const paidClinics = new Set<string>();
  const paymentIds = new Set<string>();
  const payoutIds = new Set<string>();
  let firstPayments = 0;
  let renewals = 0;
  const amounts = new Map<string, { earned: bigint; paid: bigint }>();
  const bucket = (currency: string) => {
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("invalid_currency");
    let entry = amounts.get(currency);
    if (!entry) { entry = { earned: 0n, paid: 0n }; amounts.set(currency, entry); }
    return entry;
  };
  for (const row of commissions) {
    if (!registered.has(row.workspaceId)) throw new Error("referral_scope_mismatch");
    if (!row.paymentId || paymentIds.has(row.paymentId)) throw new Error("duplicate_payment_receipt");
    if (row.kind !== "first" && row.kind !== "renewal") throw new Error("invalid_payment_kind");
    paymentIds.add(row.paymentId);
    paidClinics.add(row.workspaceId);
    if (row.kind === "first") firstPayments++; else renewals++;
    bucket(row.currency).earned += readMinor(row.amountMinor);
  }
  for (const row of payouts) {
    if (!row.id || payoutIds.has(row.id)) throw new Error("duplicate_payout_receipt");
    payoutIds.add(row.id);
    bucket(row.currency).paid += readMinor(row.amountMinor);
  }
  return {
    registrations: registered.size,
    paidClinics: paidClinics.size,
    firstPayments,
    renewals,
    balances: [...amounts].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => {
      if (value.paid > value.earned) throw new Error("partner_balance_inconsistent");
      return {
        currency,
        earnedMinor: value.earned.toString(),
        paidMinor: value.paid.toString(),
        availableMinor: (value.earned - value.paid).toString(),
      };
    }),
  };
}
