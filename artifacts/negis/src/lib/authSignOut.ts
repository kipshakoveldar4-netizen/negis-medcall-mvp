const SIGN_OUT_KEY = 'negis_signout_pending_v1';
let pendingInMemory = false;
let signOutRevision = 0;

export function getSignOutRevision(): number { return signOutRevision; }

function storage(type: 'sessionStorage' | 'localStorage'): Storage | null {
  try { return typeof window === 'undefined' ? null : window[type]; }
  catch { return null; }
}

export function isSignOutPending(): boolean {
  if (pendingInMemory) return true;
  for (const type of ['sessionStorage', 'localStorage'] as const) {
    try { if (storage(type)?.getItem(SIGN_OUT_KEY) === '1') return true; }
    catch { /* The in-memory fence still covers this document. */ }
  }
  return false;
}

export function markSignOutPending(): void {
  signOutRevision += 1;
  pendingInMemory = true;
  // A boolean tombstone, never a token or identity. Prefer this tab's storage;
  // fallback covers reload when sessionStorage is unavailable.
  for (const type of ['sessionStorage', 'localStorage'] as const) {
    try {
      const target = storage(type);
      if (target) { target.setItem(SIGN_OUT_KEY, '1'); return; }
    } catch { /* Try the other browser store. */ }
  }
}

export function clearSignOutPending(): boolean {
  for (const type of ['sessionStorage', 'localStorage'] as const) {
    try { storage(type)?.removeItem(SIGN_OUT_KEY); }
    catch { /* An observable remaining tombstone keeps the fence closed. */ }
  }
  pendingInMemory = false;
  return !isSignOutPending();
}
