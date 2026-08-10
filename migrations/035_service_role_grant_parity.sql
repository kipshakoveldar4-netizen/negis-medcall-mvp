-- NEGIS Migration 035 — цепочка догоняет production по правам служебной роли.
--
-- 023 отозвала права у anon и authenticated, и это правильно. Но явный грант
-- служебной роли с тех пор выдавался только новым таблицам: audit_logs, tasks,
-- clinic_services, clinic_doctors, clinic_doctor_shifts, appointments, deals,
-- приглашения и таблицы 026/027. Тем, что появились раньше, его не выдал никто.
--
-- На production это незаметно: там права выданы историей проекта, а не цепочкой.
-- А вот база, собранная с нуля по этим же файлам, ведёт себя иначе — сервер
-- получает отказ на самых обычных таблицах, и это обнаруживается не при сборке,
-- а при первой попытке что-то записать. 029 в своей шапке об этом расхождении
-- прямо предупреждала; здесь оно закрывается.
--
-- Ничего нового не открывается. Служебная роль и так обходит RLS — это
-- identity сервера, и весь CRM пишет от неё уже сегодня. Здесь лишь
-- записывается то, что фактически действует, чтобы одинаковый результат
-- получался и в проекте, поднятом вчера, и в поднятом год назад.
--
-- DELETE не выдаётся ни одной таблице: маршрутизатор такого метода не
-- принимает ни для одного ресурса, и выдавать серверу возможность, до которой
-- нельзя дотянуться, незачем.

begin;

grant select, insert, update on table public.workspaces to service_role;
grant select, insert, update on table public.workspace_settings to service_role;
grant select, insert, update on table public.staff_users to service_role;
grant select, insert, update on table public.clients to service_role;
grant select, insert, update on table public.leads to service_role;
grant select, insert, update on table public.calls to service_role;
grant select, insert, update on table public.chat_messages to service_role;
grant select, insert, update on table public.lead_stages to service_role;
grant select, insert, update on table public.lead_sources to service_role;
grant select, insert, update on table public.integration_statuses to service_role;
grant select, insert, update on table public.ai_provider_settings to service_role;

commit;
