import { Link } from 'wouter';
import { ArrowLeft, Construction } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';

type DemoPlaceholderProps = {
  title: string;
};

export default function DemoPlaceholder({ title }: DemoPlaceholderProps) {
  return (
    <PageLayout>
      <div className="min-h-[52vh] flex items-center justify-center">
        <section className="neu-card w-full max-w-xl p-8 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#E0F2FE] text-[#0369A1]">
            <Construction size={26} />
          </div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#64748B]">
            {title}
          </p>
          <h1 className="mt-3 text-2xl font-bold text-[#0F172A]">Раздел в разработке</h1>
          <p className="mt-3 text-sm leading-relaxed text-[#64748B]">
            Этот модуль будет подключен в следующей версии. Сейчас demo-режим сохраняет данные локально и
            оставляет CRM-навигацию доступной без пустых экранов.
          </p>
          <Link href="/dashboard">
            <div className="neu-btn-primary mt-6 inline-flex cursor-pointer items-center gap-2 px-5 py-2.5 text-sm">
              <ArrowLeft size={16} />
              Вернуться в dashboard
            </div>
          </Link>
        </section>
      </div>
    </PageLayout>
  );
}
