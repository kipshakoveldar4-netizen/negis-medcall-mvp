import React,{StrictMode,useLayoutEffect,useRef,useState} from "react";
import{createRoot}from"react-dom/client";
import{ids,supabase,switchActor}from"./partner-terms-browser-mocks";
import{Contributors}from"../../artifacts/medina-control/src/screens/Contributors";
import ContributorPortal from "../../artifacts/negis/src/pages/ContributorPortal";
import controlStyle from "../../artifacts/medina-control/src/styles.css?inline";
import productStyle from "../../artifacts/negis/src/index.css?inline";
function Harness(){
  const[session,setSession]=useState<{id:string;epoch:number}|null>(null),live=useRef(session),serial=useRef(0),[revision,setRevision]=useState(0);
  useLayoutEffect(()=>{let alive=true,observed=false;
    const apply=(s:any)=>{if(!alive)return;live.current=s?{id:s.user.id,epoch:++serial.current}:null;setSession(live.current);};
    void supabase.auth.getSession().then(({data})=>{if(!observed)apply(data.session);});const{data}=supabase.auth.onAuthStateChange((_e,s)=>{observed=true;apply(s);});
    return()=>{alive=false;live.current=null;data.subscription.unsubscribe();};},[]);
  const choose=(mode:string)=>{const query=new URLSearchParams();if(mode==='b')query.set('actor','b');if(new URLSearchParams(location.search).get('demo')==='1')query.set('demo','1');
    history.replaceState(null,'',(mode==='owner'?'/review':'/contributors')+(query.size?'?'+query:''));switchActor(mode==='owner'?ids.owner:mode==='b'?ids.b:ids.a);};
  useLayoutEffect(()=>{Object.assign((window as any).__partnerTermsQA,{view:choose,remount:()=>setRevision(n=>n+1)});},[]);
  return <><style>{session?.id===ids.owner?controlStyle:productStyle}</style><div role="note" style={{padding:"12px 16px",color:"#50665c",fontSize:13}}>Тестовый стенд · вымышленные данные</div>
    {new URLSearchParams(location.search).get('demo')==='1'&&<div style={{display:'flex',gap:8,padding:16,flexWrap:'wrap'}}>{[['owner','Владелец'],['a','Партнёр А'],['b','Партнёр Б']].map(([mode,label])=><button className="neu-btn" key={mode} type="button" onClick={()=>choose(mode)}>{label}</button>)}</div>}
    {session?.id===ids.owner?<main className="main" key={`owner:${session.epoch}:${revision}`}><Contributors/></main>:<ContributorPortal key={`partner:${session?.epoch}:${revision}`}/>}</>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness/></StrictMode>);
