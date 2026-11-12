import { PageLayout } from "@/components/layout/PageLayout";
import { DoctorSchedule } from "@/components/admin/DoctorSchedule";
import { useAuth } from "@/contexts/AuthContext";
import { termsFor, capitalize } from "../../../../lib/vertical/terms";

// Исполнители и график — страница для того, кто ведёт запись каждый день.
//
// Компонент справочника жил только вкладкой админ-центра, а туда пускает
// право view_admin — вместе с ключами интеграций и списком сотрудников.
// Администратор салона, которому нужно завести нового мастера или подвинуть
// смену, до этой вкладки не доходил и звал владельца ради каждой правки.
//
// Здесь тот же компонент под правом manage_directory: прайс и график — да,
// секреты — по-прежнему нет. Владелец и админ продолжают пользоваться вкладкой
// в админ-центре, это одна и та же форма.

export default function DirectoryPage() {
  const { vertical } = useAuth();
  const terms = termsFor(vertical);

  return (
    <PageLayout>
      <header className="negis-glass-hero p-5 sm:p-6">
        <h1 className="text-xl font-black text-[#0F172A] sm:text-2xl">{capitalize(terms.specialistPlural)} и график</h1>
        <p className="mt-2 text-sm font-semibold leading-relaxed text-[#475569]">
          Справочник тех, кто ведёт {terms.visitPlural}, их смены и исключения по датам.
        </p>
      </header>
      <div className="mt-5">
        <DoctorSchedule />
      </div>
    </PageLayout>
  );
}
