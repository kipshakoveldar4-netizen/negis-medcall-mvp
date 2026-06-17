import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { apiUrl } from '@/lib/api';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';

/* ── Styles ───────────────────────────────────────────────── */
const Wrap: React.CSSProperties = {
  minHeight: '100vh',
  background: '#F4F7FB',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: "'Inter', sans-serif",
  padding: 24,
};

const Card: React.CSSProperties = {
  background: '#F4F7FB',
  borderRadius: 24,
  boxShadow: '8px 8px 20px #D1D9E6, -8px -8px 20px #FFFFFF',
  padding: '48px 40px',
  maxWidth: 440,
  width: '100%',
  textAlign: 'center',
};

const LinkBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 20,
  padding: '10px 22px',
  borderRadius: 12,
  background: '#1E325C',
  color: '#FFF',
  fontSize: 14,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
};

/* ═══════════════════════════════════════════════════════════
   AdsCallback — handles TikTok OAuth redirect
═══════════════════════════════════════════════════════════ */
export default function AdsCallback() {
  const [, setLocation] = useLocation();
  const { clinicId } = useAuth();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    handleCallback();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCallback = async () => {
    /* 1. Parse URL params */
    const params = new URLSearchParams(window.location.search);
    const code      = params.get('code');
    const state     = params.get('state'); // clinic_id passed as state
    const errorCode = params.get('error');

    if (errorCode) {
      setErrorMsg(`TikTok вернул ошибку: ${errorCode}`);
      setStatus('error');
      return;
    }

    if (!code) {
      setErrorMsg('Параметр "code" отсутствует в URL');
      setStatus('error');
      return;
    }

    /* Use state param as clinic_id (set during OAuth initiation),
       fall back to clinicId from auth context */
    const resolvedClinicId = state || clinicId;
    if (!resolvedClinicId) {
      setErrorMsg('Не удалось определить clinic_id. Попробуйте подключить TikTok снова.');
      setStatus('error');
      return;
    }

    /* 2. Exchange code for access token via API server (server-side, secret stays safe) */
    let accessToken = '';
    let advertiserId = '';
    let accountName = '';

    try {
      const res = await fetch(apiUrl('/api/ads/tiktok/callback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, clinic_id: resolvedClinicId }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `Ошибка сервера: ${res.status}`);
      }

      accessToken  = data.access_token;
      advertiserId = data.advertiser_id;
      accountName  = data.account_name ?? advertiserId;
    } catch (e: any) {
      setErrorMsg(e.message || 'Ошибка при обмене кода на токен');
      setStatus('error');
      return;
    }

    /* 3. Save to ad_accounts table */
    try {
      const { error: dbError } = await supabase.from('ad_accounts').insert({
        clinic_id:    resolvedClinicId,
        platform:     'tiktok',
        account_id:   advertiserId,
        account_name: accountName,
        access_token: accessToken,
        is_active:    true,
      });

      if (dbError) throw new Error(dbError.message);
    } catch (e: any) {
      setErrorMsg(`Ошибка сохранения: ${e.message}`);
      setStatus('error');
      return;
    }

    /* 4. Redirect to /ads with success toast */
    setStatus('success');
    toast.success(`TikTok Ads подключён: ${accountName}`);
    setTimeout(() => setLocation('/ads'), 1500);
  };

  /* ── Render ──────────────────────────────────────────────── */
  return (
    <div style={Wrap}>
      <div style={Card}>
        {status === 'processing' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              <Loader2
                size={48}
                color="#1E325C"
                style={{ animation: 'spin 1s linear infinite' }}
              />
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0B1220', marginBottom: 8 }}>
              Подключение TikTok Ads...
            </h2>
            <p style={{ fontSize: 14, color: '#64748B', lineHeight: 1.6 }}>
              Обмениваем код авторизации на токен доступа
            </p>
          </>
        )}

        {status === 'success' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              <CheckCircle2 size={48} color="#16A34A" />
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0B1220', marginBottom: 8 }}>
              TikTok Ads подключён
            </h2>
            <p style={{ fontSize: 14, color: '#64748B' }}>
              Перенаправляем на страницу рекламы...
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              <AlertCircle size={48} color="#DC2626" />
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0B1220', marginBottom: 8 }}>
              Ошибка подключения
            </h2>
            <p style={{ fontSize: 14, color: '#64748B', lineHeight: 1.6, marginBottom: 4 }}>
              {errorMsg}
            </p>
            <button style={LinkBtn} onClick={() => setLocation('/ads')}>
              Вернуться в Рекламу
            </button>
          </>
        )}
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
