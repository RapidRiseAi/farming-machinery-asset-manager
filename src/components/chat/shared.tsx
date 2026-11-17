"use client";
import { useMemo, useState } from "react";
import { createSingleFlight } from "@/lib/single-flight";
import { t, type Lang } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReportPending } from "@/components/ui/pending-guard";
import { CHAT_PAGE, type ChatPerson } from "@/lib/chat/protocol";

export async function chatRequest(path: string, body?: unknown) {
  const response=await fetch(`/api/chat${path}`,{cache:"no-store",...(body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
  if(!response.ok)throw new Error(response.status===403||response.status===401?"forbidden":"chat-failed");
  return response.json();
}
export function useChatTask() {
  const [busy,setBusy]=useState(false),[error,setError]=useState(false);
  const flight=useMemo(()=>createSingleFlight<[()=>Promise<void>]>(async work=>{
    setBusy(true);setError(false);
    try{await work();}catch{setError(true);}finally{setBusy(false);}
  }),[]);
  return {busy,error,run:flight.run};
}
export function TaskState({busy,error,locale}:{busy:boolean;error:boolean;locale:Lang}) {
  return <><ReportPending pending={busy}/>{error?<p role="alert" className="text-sm text-status-overdue">{t("chat.failed",locale)}</p>:null}</>;
}
export function PeoplePicker({farm,locale,selected,onChange}:{farm:string;locale:Lang;selected:string[];onChange:(ids:string[])=>void}) {
  const [search,setSearch]=useState(""),[people,setPeople]=useState<ChatPerson[]>([]),[more,setMore]=useState(false);
  const task=useChatTask();
  const load=(append:boolean)=>task.run(async()=>{
    const result=await chatRequest(`?farm=${farm}&people=1&search=${encodeURIComponent(search)}&offset=${append?people.length:0}`);
    setPeople(append?[...people,...result.data]:result.data);setMore(result.data.length===CHAT_PAGE);
  });
  return <div className="flex flex-col gap-3">
    <label className="text-sm font-medium">{t("chat.findPeople",locale)}<Input value={search} onChange={e=>setSearch(e.target.value)} maxLength={120}/></label>
    <Button variant="secondary" loading={task.busy} onClick={()=>void load(false)}>{t("chat.findPeople",locale)}</Button>
    <TaskState {...task} locale={locale}/>
    {people.map(person=><label key={person.id} className="flex min-h-[44px] items-center gap-3 text-sm">
      <input type="checkbox" checked={selected.includes(person.id)} onChange={e=>onChange(e.target.checked?[...selected,person.id]:selected.filter(id=>id!==person.id))}/>{person.name}
    </label>)}
    {more?<Button variant="secondary" loading={task.busy} onClick={()=>void load(true)}>{t("chat.more",locale)}</Button>:null}
    <p className="text-sm text-sand-600">{t("chat.selected",locale).replace("{count}",String(selected.length))}</p>
  </div>;
}
