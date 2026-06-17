import React, { useState } from 'react';
import { PageLayout } from '@/components/layout/PageLayout';
import { useForm } from 'react-hook-form';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import { useLocation } from 'wouter';

export default function Onboarding() {
  const [step, setStep] = useState(1);
  const [, setLocation] = useLocation();

  const handleNext = () => setStep(s => Math.min(s + 1, 4));
  const handlePrev = () => setStep(s => Math.max(s - 1, 1));

  const finishOnboarding = async () => {
    // In a real app, we'd update the clinic and save all data
    toast.success('Настройка завершена!');
    setLocation('/dashboard');
  };

  return (
    <PageLayout requireAuth={false}>
      <div className="max-w-2xl mx-auto mt-10">
        <div className="mb-8">
          <div className="h-2 w-full bg-border rounded-full overflow-hidden neu-pressed">
            <div 
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${(step / 4) * 100}%` }}
            />
          </div>
          <div className="mt-2 text-center text-sm font-medium text-muted-foreground">
            Шаг {step} из 4
          </div>
        </div>

        <div className="neu-card">
          {step === 1 && (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold text-center mb-6">Настройки клиники</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Название клиники</label>
                  <input type="text" className="neu-input" defaultValue="Моя Клиника" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Начало работы</label>
                    <input type="time" className="neu-input" defaultValue="10:00" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Конец работы</label>
                    <input type="time" className="neu-input" defaultValue="18:00" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Максимум записей на слот</label>
                  <input type="number" className="neu-input" defaultValue={3} min={1} />
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold text-center mb-6">Первый агент</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Имя агента</label>
                  <input type="text" className="neu-input" placeholder="Иван Иванов" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Email</label>
                  <input type="email" className="neu-input" placeholder="agent@clinic.kz" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Пароль</label>
                  <input type="password" className="neu-input" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Роль</label>
                  <select className="neu-input bg-transparent">
                    <option value="operator">Оператор</option>
                    <option value="receptionist">Ресепшн</option>
                    <option value="manager">Менеджер</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Часовая ставка (₸)</label>
                    <input type="number" className="neu-input" defaultValue={2000} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Недельный таргет (записей)</label>
                    <input type="number" className="neu-input" defaultValue={50} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold text-center mb-6">Услуги</h2>
              <div className="flex gap-4">
                <input type="text" className="neu-input flex-1" placeholder="Название услуги" />
                <input type="number" className="neu-input w-32" placeholder="Цена ₸" />
                <button className="neu-btn-primary whitespace-nowrap">+ Добавить</button>
              </div>
              <div className="space-y-2 mt-4">
                <div className="neu-sm p-3 flex justify-between items-center">
                  <span>Консультация врача</span>
                  <div className="flex items-center gap-4">
                    <span className="font-bold">5 000 ₸</span>
                    <button className="text-destructive font-medium hover:underline text-sm">Удалить</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold text-center mb-6">Уведомления</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Telegram Chat ID</label>
                  <input type="text" className="neu-input" placeholder="-100123456789" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Номер WhatsApp</label>
                  <input type="text" className="neu-input" placeholder="+7 777 123 45 67" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Шаблон WhatsApp</label>
                  <textarea 
                    className="neu-input min-h-[100px] resize-y" 
                    defaultValue="Здравствуйте, {имя}! Вы записаны на услугу {услуга} {дата} в {время}. Ваш специалист: {агент}."
                  />
                  <p className="text-xs text-muted-foreground mt-1">Доступные переменные: {'{имя} {дата} {время} {услуга} {агент}'}</p>
                </div>
                <div className="neu p-4 mt-4">
                  <p className="text-sm font-medium mb-2">Предпросмотр:</p>
                  <p className="text-sm">Здравствуйте, Александр! Вы записаны на услугу Консультация 24.10.2023 в 14:00. Ваш специалист: Анна.</p>
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-between mt-8">
            <button 
              className="neu-btn" 
              onClick={handlePrev}
              disabled={step === 1}
              style={{ opacity: step === 1 ? 0.5 : 1 }}
            >
              Назад
            </button>
            {step < 4 ? (
              <button className="neu-btn-primary" onClick={handleNext}>Далее</button>
            ) : (
              <button className="neu-btn-primary" onClick={finishOnboarding}>Завершить настройку</button>
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
