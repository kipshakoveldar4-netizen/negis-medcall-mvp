import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/contexts/AuthContext";
import { crmFetch } from "@/lib/api";
import { VERTICALS, termsFor, VERTICAL_SETTINGS_KEY, type Vertical } from "../../../../../lib/vertical/terms";

// Выбор ниши рабочего пространства.
//
// Ниша решает три вещи: как продукт называет врача и пациента, какие правила
// применяются к рекламе и какая оговорка приписывается к объявлению. До этого
// переключателя вертикаль читалась на сервере и ехала в браузер, но задать её
// было нечем — то есть весь механизм существовал вхолостую.
//
// Пишется через существующий маршрут admin-settings: он кладёт произвольный
// ключ в workspace_settings и уже закрыт правом администратора рабочего
// пространства. Заводить отдельный маршрут ради одного значения незачем.
//
// Смена ниши требует перезагрузки, и экран об этом говорит прямо: подписи и
// правила разбираются при загрузке приложения, а не по каждому нажатию.
// Молча оставить половину экранов на старом словаре было бы хуже.

const LABELS: Readonly<Record<Vertical, { title: string; note: string }>> = {
  clinic: {
    title: "Медицинская клиника",
    note: "Врачи и пациенты. Реклама проверяется по медицинским правилам: говорить о лечении можно, называть состояние читателя — нет.",
  },
  dental: {
    title: "Стоматология",
    note: "Стоматологи и пациенты. Реклама идёт по медицинским правилам, как у клиники: рассказывать о лечении можно, называть диагноз читателя — нет.",
  },
  beauty: {
    title: "Салон красоты",
    note: "Мастера и клиенты. Называть услугу своим именем можно; обещать лечение — нельзя, салон его не оказывает.",
  },
};

export function VerticalSwitch() {
  const { vertical } = useAuth();
  const [saving, setSaving] = useState<Vertical | null>(null);

  async function choose(next: Vertical) {
    if (next === vertical) return;
    setSaving(next);
    try {
      const response = await crmFetch("/api/crm/admin-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: VERTICAL_SETTINGS_KEY, value: { vertical: next } }),
      });
      if (!response.ok) throw new Error(String(response.status));
      toast.success("Ниша сохранена. Перезагрузите страницу, чтобы подписи и правила обновились.");
    } catch {
      toast.error("Не удалось сохранить нишу");
    } finally {
      setSaving(null);
    }
  }

  const terms = termsFor(vertical);

  return (
    <section className="neu-card" aria-label="Ниша">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Ниша</p>
      <h2 className="mt-1 text-base font-black text-[#0F172A]">{LABELS[vertical].title}</h2>
      <p className="mt-1 text-sm text-[#64748B]">
        Сейчас продукт говорит «{terms.specialist}» и «{terms.customer}».
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {VERTICALS.map((option) => (
          <button
            key={option}
            type="button"
            disabled={saving !== null}
            onClick={() => void choose(option)}
            className={`rounded-2xl border p-4 text-left ${
              option === vertical ? "border-[#0F172A] bg-white" : "border-[#D8E4EC] bg-white/65"
            }`}
          >
            <p className="flex items-center gap-2 text-sm font-black text-[#0F172A]">
              {saving === option ? <Loader2 className="animate-spin" size={14} /> : null}
              {LABELS[option].title}
              {option === vertical ? " · выбрано" : ""}
            </p>
            <p className="mt-1 text-xs font-semibold leading-relaxed text-[#64748B]">{LABELS[option].note}</p>
          </button>
        ))}
      </div>

      {/*
        Не «настройка внешнего вида». Ниша меняет то, что продукт разрешает
        написать в рекламе, и оператор должен понимать, что переключает.
      */}
      <p className="mt-3 text-xs font-semibold leading-relaxed text-[#64748B]">
        Ниша влияет не только на подписи: от неё зависит, какие формулировки проверка рекламы считает
        недопустимыми. Салону запрещено обещать лечение, клинике — нет.
      </p>
    </section>
  );
}
