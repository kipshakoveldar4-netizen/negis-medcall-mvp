import { apiUrl } from '@/lib/api';

export const CRM_SOURCES = ['Instagram', 'Google', 'WhatsApp', '2GIS', 'Вручную', 'Webhook', 'Import', 'Negis App'];
export const BOOKING_SOURCES = ['CRM', 'Instagram', 'WhatsApp', 'Import', 'Negis App'];

export const sourceValueToLabel = (source: string | null | undefined) => {
  if (source === 'negis_app' || source === 'Negis App') return 'Negis App';
  if (!source || source === 'crm') return 'CRM';
  return source;
};

export const sourceLabelToValue = (label: string) => label === 'Negis App' ? 'negis_app' : label;
export const isNegisAppSource = (source: string | null | undefined) => source === 'negis_app' || source === 'Negis App';

export const QR_STATUS_LABELS: Record<string, string> = {
  created: 'QR создан',
  confirmed: 'QR подтверждён',
  expired: 'QR истёк',
  used: 'QR использован',
  reused: 'QR использован повторно',
};

export const BONUS_STATUS_LABELS: Record<string, string> = {
  pending: 'не начислены',
  accrued: 'начислены',
  spent: 'списаны',
  cancelled: 'отменены',
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `API ${response.status}`);
  }
  return payload as T;
}

export interface QrScanResult {
  valid: boolean;
  message?: string;
  token?: string;
  appointment?: {
    id: string;
    clinic_id?: string;
    branch_id?: string | null;
    client_id?: string | null;
    client_name?: string | null;
    client_phone?: string | null;
    service_name?: string | null;
    staff_name?: string | null;
    date?: string;
    time?: string;
    source?: string | null;
    qr_status?: string | null;
    bonus_status?: string | null;
    bonus_reward?: number | null;
  };
}

export const scanQrToken = (token: string, clinicId: string, deviceInfo?: string) =>
  requestJson<QrScanResult>('/api/crm/app/qr/scan', {
    method: 'POST',
    body: JSON.stringify({ token, clinic_id: clinicId, device_info: deviceInfo }),
  });

export const confirmQrArrival = (token: string, clinicId: string, confirmedBy?: string | null) =>
  requestJson<QrScanResult>('/api/crm/app/qr/confirm-arrival', {
    method: 'POST',
    body: JSON.stringify({ token, clinic_id: clinicId, confirmed_by: confirmedBy }),
  });

export const confirmAppAppointmentArrival = (appointmentId: string, clinicId: string, confirmedBy?: string | null) =>
  requestJson<{ ok: boolean; appointment?: unknown }>(`/api/crm/app/appointments/${appointmentId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ clinic_id: clinicId, confirmed_by: confirmedBy }),
  });

export const fetchAppClientByPhone = (phone: string) =>
  requestJson<{ id?: string; bonus_balance?: number; bonusBalance?: number; linked?: boolean }>(
    `/api/crm/app/client/${encodeURIComponent(phone)}`,
  );

export const spendAppBonus = (payload: {
  clinic_id: string;
  client_phone?: string | null;
  client_id?: string | null;
  booking_id?: string | null;
  lead_id?: string | null;
  amount: number;
  service_price: number;
}) =>
  requestJson<{ ok: boolean; balance?: number }>('/api/crm/app/bonus/spend', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
