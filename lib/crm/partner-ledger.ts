import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthenticatedUser } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { parsePartnerLedger } from "./partner-contracts";

export async function handlePartnerLedger(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control","no-store");
  const fail = (status:number,error:string) => res.status(status).json({success:false,error});
  if (req.method!=="GET") return fail(405,"Метод не разрешён.");
  const user=await requireAuthenticatedUser(req);
  if (Object.keys(req.query).some(key=>key!=="path")) return fail(400,"Параметры отчёта не разрешены.");
  const db=getSupabaseServerClient();
  if (!db) return fail(503,"Партнёрская статистика временно недоступна.");
  const {data,error}=await db.rpc("read_growth_partner_ledger",{p_actor:user.id});
  if (error) return error.code==="P1091" ? fail(403,"Доступ партнёра изменился. Обновите профиль.")
    : fail(503,"Не удалось подтвердить партнёрскую статистику. Попробуйте позже.");
  const ledger=parsePartnerLedger(data);
  return ledger ? res.status(200).json({success:true,data:ledger}) : fail(503,"Не удалось подтвердить партнёрскую статистику. Попробуйте позже.");
}
