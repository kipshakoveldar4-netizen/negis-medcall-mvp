import { useEffect, useRef, useState } from 'react';
import { Camera, Check, QrCode, X } from 'lucide-react';
import { toast } from 'sonner';
import { confirmQrArrival, scanQrToken, type QrScanResult } from '@/lib/negisApp';

interface NegisQrScannerProps {
  clinicId: string | null;
  userId?: string | null;
  onClose: () => void;
  onConfirmed?: () => void;
}

export function NegisQrScanner({ clinicId, userId, onClose, onConfirmed }: NegisQrScannerProps) {
  const [token, setToken] = useState('');
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QrScanResult | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);

  const stopCamera = () => {
    if (scanTimerRef.current) window.clearInterval(scanTimerRef.current);
    scanTimerRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    setScanning(false);
  };

  useEffect(() => stopCamera, []);

  const runScan = async (value: string) => {
    if (!clinicId) {
      toast.error('Клиника не выбрана');
      return;
    }
    const clean = value.trim();
    if (!clean) {
      toast.error('QR токен пустой');
      return;
    }
    setLoading(true);
    try {
      const payload = await scanQrToken(clean, clinicId, navigator.userAgent);
      setResult({ ...payload, token: clean });
      setToken(clean);
    } catch (e: any) {
      setResult(null);
      toast.error(e.message || 'QR не прошёл проверку');
    } finally {
      setLoading(false);
    }
  };

  const startCamera = async () => {
    try {
      const Detector = (window as any).BarcodeDetector;
      if (!Detector) {
        toast.error('В этом браузере нет QR-сканера. Вставьте токен вручную.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const detector = new Detector({ formats: ['qr_code'] });
      setScanning(true);
      scanTimerRef.current = window.setInterval(async () => {
        if (!videoRef.current || videoRef.current.readyState < 2) return;
        const codes = await detector.detect(videoRef.current);
        const rawValue = codes?.[0]?.rawValue;
        if (rawValue) {
          stopCamera();
          runScan(rawValue);
        }
      }, 700);
    } catch (e: any) {
      toast.error(e.message || 'Не удалось открыть камеру');
      stopCamera();
    }
  };

  const confirmArrival = async () => {
    if (!clinicId || !result?.token) return;
    setLoading(true);
    try {
      await confirmQrArrival(result.token, clinicId, userId);
      toast.success('Приход подтверждён, бонусы будут начислены backend API');
      onConfirmed?.();
      onClose();
    } catch (e: any) {
      toast.error(e.message || 'Не удалось подтвердить приход');
    } finally {
      setLoading(false);
    }
  };

  const app = result?.appointment;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-3xl border border-[#E7ECF3] bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#E7ECF3] px-6 py-4">
          <div>
            <div className="text-lg font-bold text-[#0B1220]">Сканировать QR</div>
            <div className="text-sm text-[#64748B]">Проверка идёт только через backend Negis App</div>
          </div>
          <button type="button" className="neu-icon-btn h-9 w-9" onClick={() => { stopCamera(); onClose(); }}>
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div className="rounded-2xl border border-[#E7ECF3] bg-[#F8FAFC] p-4">
            {scanning ? (
              <video ref={videoRef} className="aspect-video w-full rounded-xl bg-black object-cover" muted playsInline />
            ) : (
              <div className="flex aspect-video w-full flex-col items-center justify-center rounded-xl border border-dashed border-[#CBD5E1] text-[#64748B]">
                <QrCode size={38} />
                <div className="mt-2 text-sm font-semibold">Камера или ручной ввод токена</div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <input
              className="neu-input"
              placeholder="Вставьте QR token, если камера недоступна"
              value={token}
              onChange={e => setToken(e.target.value)}
            />
            <button type="button" className="neu-btn-primary px-4" onClick={() => runScan(token)} disabled={loading}>
              Проверить
            </button>
          </div>

          <div className="flex gap-2">
            <button type="button" className="neu-btn flex items-center gap-2" onClick={startCamera} disabled={scanning || loading}>
              <Camera size={15} /> Открыть камеру
            </button>
            {scanning && (
              <button type="button" className="neu-btn" onClick={stopCamera}>
                Остановить
              </button>
            )}
          </div>

          {result && (
            <div className={`rounded-2xl border p-4 ${result.valid ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
              <div className={`font-bold ${result.valid ? 'text-green-700' : 'text-red-600'}`}>
                {result.valid ? 'QR валиден' : 'QR не валиден'}
              </div>
              {result.message && <div className="mt-1 text-sm text-[#64748B]">{result.message}</div>}
              {app && (
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <Info label="Клиент" value={app.client_name || app.client_phone || '—'} />
                  <Info label="Услуга" value={app.service_name || '—'} />
                  <Info label="Время" value={`${app.date ?? '—'} ${app.time ?? ''}`} />
                  <Info label="Специалист" value={app.staff_name || '—'} />
                </div>
              )}
              {result.valid && (
                <button type="button" className="mt-4 neu-btn-primary flex items-center gap-2" onClick={confirmArrival} disabled={loading}>
                  <Check size={15} /> Подтвердить приход
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-[#94A3B8]">{label}</div>
      <div className="font-semibold text-[#0B1220]">{value}</div>
    </div>
  );
}
