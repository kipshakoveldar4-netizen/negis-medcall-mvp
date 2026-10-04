export type OperatorBookingAttemptPayload = {
  leadId: string;
  doctorId: string;
  serviceIds: string[];
  startsLocal: string;
  timeZone: string;
};

export type OperatorBookingAttempt = {
  requestId: string;
  requestKey: string;
  payload: OperatorBookingAttemptPayload;
  uncertain: boolean;
};

export function newOperatorBookingAttempt(
  requestId: string,
  payload: OperatorBookingAttemptPayload,
  makeKey: () => string = () => crypto.randomUUID(),
): OperatorBookingAttempt {
  return {
    requestId,
    requestKey: makeKey(),
    payload: { ...payload, serviceIds: [...payload.serviceIds] },
    uncertain: false,
  };
}

export function isCurrentOperatorBookingAttempt(
  attempt: OperatorBookingAttempt,
  requestId: string,
  leadId: string,
): boolean {
  return attempt.requestId === requestId && attempt.payload.leadId === leadId;
}

export function canReleaseOperatorBookingAttempt(status: number): boolean {
  // Validation, access and business conflicts are definite refusals. Network
  // failures and 5xx responses may have lost a successful provider response.
  return [400, 401, 403, 409, 422].includes(status);
}
