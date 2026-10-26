import type { MortgageActivity, MortgageContact, MortgageSnapshot } from '../../lib/crm/mortgage-contract';

// In-memory loopback fixture only; never imported by the application entry.
const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Almaty'});
const stamp=new Date().toISOString();
const nextDay = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
const laterDay = new Date(Date.now() + 3 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
const manager='00000000-0000-4000-8000-000000000100';
const second='00000000-0000-4000-8000-000000000101';
export const mortgageFixtureAdmin={id:'00000000-0000-4000-8000-000000000011',name:'Тестовый администратор',role:'admin',status:'active'};
const contacts:MortgageContact[]=Array.from({length:6},(_,i)=>({
  id:`00000000-0000-4000-8000-${String(200+i).padStart(12,'0')}`,
  name:['Тестовая Анна Садыкова','Тестовый Ерлан Касымов','Тестовая Мария Константинопольская','Тестовый Арман','Тестовая Алия','Тестовый неназначенный клиент'][i],
  phone:`+7700000010${i}`,notes:'Вымышленные данные изолированного локального стенда',status:i===1?'in_progress':'new',source:i===2?'whatsapp':'manual',
  createdAt:stamp,updatedAt:stamp,responsibleUserId:i===5?null:i%2===0?manager:second,
  responsibleName:i===5?null:i%2===0?'Тестовая Александра Константинопольская':'Тестовый менеджер 2',
}));
let activities:MortgageActivity[]=[
  {id:'00000000-0000-4000-8000-000000000300',kind:'meeting',leadId:contacts[0].id,title:'Консультация с Анной',notes:'Вымышленная встреча',status:'open',priority:'normal',startsAt:`${today}T10:00:00+05:00`,endsAt:`${today}T11:00:00+05:00`,dueAt:null,createdAt:stamp,updatedAt:stamp,contactName:contacts[0].name,responsibleUserId:manager,responsibleName:contacts[0].responsibleName},
  {id:'00000000-0000-4000-8000-000000000301',kind:'meeting',leadId:contacts[1].id,title:'Встреча с Ерланом',notes:'',status:'open',priority:'normal',startsAt:`${today}T12:30:00+05:00`,endsAt:`${today}T13:00:00+05:00`,dueAt:null,createdAt:stamp,updatedAt:stamp,contactName:contacts[1].name,responsibleUserId:second,responsibleName:contacts[1].responsibleName},
  {id:'00000000-0000-4000-8000-000000000302',kind:'task',leadId:contacts[0].id,title:'Перезвонить клиенту',notes:'Вымышленная задача',status:'open',priority:'high',startsAt:null,endsAt:null,dueAt:new Date(Date.now()-86400000).toISOString(),createdAt:stamp,updatedAt:stamp,contactName:contacts[0].name,responsibleUserId:manager,responsibleName:contacts[0].responsibleName},
  {id:'00000000-0000-4000-8000-000000000303',kind:'meeting',leadId:contacts[2].id,title:'Обсуждение ипотечной программы',notes:'Вымышленная будущая встреча для проверки главной',status:'open',priority:'normal',startsAt:`${nextDay}T11:00:00+05:00`,endsAt:`${nextDay}T12:00:00+05:00`,dueAt:null,createdAt:stamp,updatedAt:stamp,contactName:contacts[2].name,responsibleUserId:manager,responsibleName:contacts[2].responsibleName},
  {id:'00000000-0000-4000-8000-000000000304',kind:'meeting',leadId:contacts[3].id,title:'Проверка пакета документов',notes:'Вымышленная будущая встреча для проверки главной',status:'open',priority:'normal',startsAt:`${laterDay}T15:30:00+05:00`,endsAt:`${laterDay}T16:15:00+05:00`,dueAt:null,createdAt:stamp,updatedAt:stamp,contactName:contacts[3].name,responsibleUserId:second,responsibleName:contacts[3].responsibleName},
];
const receipts=new Map<string,{id:string;payload:string}>();
export async function mortgageLeadBrowserRequest(init:RequestInit|undefined,role:string):Promise<Response>{
  const method=init?.method||'GET';
  const visible=contacts.filter(c=>role!=='lead_manager'||c.responsibleUserId===manager);
  if(method==='GET')return Response.json({success:true,mode:'supabase',data:{leads:visible,items:visible}});
  const body=JSON.parse(String(init?.body||'{}'));
  if(method==='POST'){
    if(!['owner','admin'].includes(role))return Response.json({error:'Доступ закрыт'},{status:403});
    const responsibleUserId=[manager,second,...(role==='admin'?[mortgageFixtureAdmin.id]:[])].includes(body.responsibleUserId)?body.responsibleUserId:null;
    if(body.responsibleUserId&&!responsibleUserId)return Response.json({error:'Ответственный недоступен'},{status:400});
    const item:MortgageContact={id:crypto.randomUUID(),name:body.name,phone:body.phone,notes:body.notes||'',status:'new',source:'manual',
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),responsibleUserId,
      responsibleName:responsibleUserId===manager?'Тестовая Александра Константинопольская':responsibleUserId===second?'Тестовый менеджер 2':responsibleUserId===mortgageFixtureAdmin.id?mortgageFixtureAdmin.name:null};
    contacts.push(item);
    return Response.json({success:true,mode:'supabase',data:{item}});
  }
  const item=visible.find(c=>c.id===body.id);
  if(method!=='PATCH'||!item)return Response.json({error:'Клиент недоступен'},{status:404});
  for(const key of ['name','phone','notes','status'] as const)if(typeof body.updates?.[key]==='string')item[key]=body.updates[key];
  item.updatedAt=new Date().toISOString();
  return Response.json({success:true,mode:'supabase',data:{item}});
}
export async function mortgageBrowserRequest(url:URL,init:RequestInit|undefined,role:string):Promise<Response>{
  const method=init?.method||'GET';
  const visible=contacts.filter(c=>role!=='lead_manager'||c.responsibleUserId===manager);
  if(method==='GET'){
    const q=(url.searchParams.get('q')||'').toLowerCase(),leadId=url.searchParams.get('leadId');
    if(leadId&&!visible.some(c=>c.id===leadId))return Response.json({error:'Клиент недоступен'},{status:404});
    const selected=visible.filter(c=>(!leadId||c.id===leadId)&&(!q||`${c.name} ${c.phone}`.toLowerCase().includes(q)));
    const page=Number(url.searchParams.get('page')||0),days=Number(url.searchParams.get('days')||30);
    const ownedActivities=activities.filter(a=>visible.some(c=>c.id===a.leadId)&&(!leadId||a.leadId===leadId));
    const members=[{id:manager,name:'Тестовая Александра Константинопольская',role:'lead_manager',status:'active'},
      {id:second,name:'Тестовый менеджер 2',role:'lead_manager',status:'active'},mortgageFixtureAdmin].filter(m=>role!=='lead_manager'||m.id===manager);
    const generatedAt=new Date().toISOString();
    const data:MortgageSnapshot={generatedAt,period:{days,from:new Date(Date.parse(generatedAt)-days*86400000).toISOString(),to:generatedAt},
      timeZone:'Asia/Almaty',contacts:selected.slice(page*100,(page+1)*100),contactsTotal:selected.length,page,pageSize:100,
      activities:ownedActivities,activitiesTruncated:false,members,events:[],periodDays:days,
      metrics:{totalLeads:visible.length,unassignedLeads:visible.filter(c=>!c.responsibleUserId).length,inProgressLeads:visible.filter(c=>c.status==='in_progress').length,
        meetingsToday:ownedActivities.filter(a=>a.kind==='meeting'&&a.status!=='cancelled'&&a.startsAt&&new Date(a.startsAt).toLocaleDateString('en-CA',{timeZone:'Asia/Almaty'})===today).length,
        overdueTasks:ownedActivities.filter(a=>a.kind==='task'&&a.status==='open'&&a.dueAt&&Date.parse(a.dueAt)<Date.now()).length,activeManagers:members.filter(m=>m.role==='lead_manager'&&m.status==='active').length},
      memberMetrics:role==='lead_manager'?[]:members.map(m=>({id:m.id,name:m.name,role:m.role,assignedLeads:contacts.filter(c=>c.responsibleUserId===m.id).length,
        openTasks:ownedActivities.filter(a=>a.kind==='task'&&a.responsibleUserId===m.id&&a.status==='open').length,
        overdueTasks:ownedActivities.filter(a=>a.kind==='task'&&a.responsibleUserId===m.id&&a.status==='open'&&a.dueAt&&Date.parse(a.dueAt)<Date.now()).length,
        doneTasks:0,plannedMeetings:ownedActivities.filter(a=>a.kind==='meeting'&&a.responsibleUserId===m.id&&a.status==='open').length,doneMeetings:0,missedMeetings:0}))};
    return Response.json({success:true,mode:'supabase',data});
  }
  const body=JSON.parse(String(init?.body||'{}'));
  const contact=visible.find(c=>c.id===body.leadId);
  if(!contact)return Response.json({error:'Клиент недоступен'},{status:404});
  if(body.kind==='meeting'&&!contact.responsibleUserId)return Response.json({error:'Сначала назначьте ответственного',code:'lead_requires_assignment'},{status:409});
  const existing=method==='PATCH'?activities.find(a=>a.id===body.id):undefined;
  if(method==='PATCH'&&(!existing||existing.updatedAt!==body.expectedUpdatedAt))return Response.json({error:'Запись уже изменена',code:'activity_changed'},{status:409});
  if(method==='POST'&&receipts.has(body.requestId))return Response.json({success:true,mode:'supabase',data:{id:receipts.get(body.requestId)!.id,replayed:true}});
  if(body.kind==='meeting'&&body.status==='open'&&activities.some(a=>a.id!==body.id&&a.kind==='meeting'&&a.status==='open'
    &&a.responsibleUserId===contact.responsibleUserId&&Date.parse(a.startsAt!)<Date.parse(body.endsAt)&&Date.parse(a.endsAt!)>Date.parse(body.startsAt))){
    return Response.json({error:'На это время уже назначена встреча',code:'meeting_conflict'},{status:409});
  }
  const item:MortgageActivity={...body,id:existing?.id||crypto.randomUUID(),createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),
    contactName:contact.name,responsibleUserId:contact.responsibleUserId,responsibleName:contact.responsibleName};
  activities=existing?activities.map(a=>a.id===item.id?item:a):[...activities,item];
  if(method==='POST')receipts.set(body.requestId,{id:item.id,payload:String(init?.body)});
  return Response.json({success:true,mode:'supabase',data:{id:item.id,updatedAt:item.updatedAt,replayed:false}});
}
