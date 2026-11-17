"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { t, type Lang } from "@/lib/i18n";
import { CHAT_PAGE, type ChatSummary } from "@/lib/chat/protocol";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DialogForm } from "@/components/ui/dialog-form";
import { chatRequest, PeoplePicker, TaskState, useChatTask } from "./shared";

export function ChatHome({farm,locale}:{farm:string;locale:Lang}) {
  const [rooms,setRooms]=useState<ChatSummary[]>([]),[more,setMore]=useState(false),[ready,setReady]=useState(false);
  const [kind,setKind]=useState("direct"),[title,setTitle]=useState(""),[people,setPeople]=useState<string[]>([]);
  const [id,setId]=useState(""); const router=useRouter(), task=useChatTask();
  const {run}=task;
  const load=useCallback(async(offset=0)=>{
    try {
      const result=await chatRequest(`?farm=${farm}&offset=${offset}`);
      setRooms(previous=>offset?[...new Map([...previous,...result.data].map((room:ChatSummary)=>[room.id,room])).values()]:result.data);setMore(result.data.length===CHAT_PAGE);setReady(true);
    } catch(error) {
      if(error instanceof Error&&error.message==="forbidden"){setRooms([]);setMore(false);setReady(false);}
      throw error;
    }
  },[farm]);
  useEffect(()=>{setId(crypto.randomUUID());void run(()=>load());},[load,run]);
  useEffect(()=>{
    const db=createClient();
    const refresh=()=>{if(document.visibilityState==="visible")void run(()=>load());};
    const channel=db.channel(`chat-list:${farm}`).on("postgres_changes",{event:"UPDATE",schema:"public",table:"chat_conversations",filter:`farm_id=eq.${farm}`},refresh).subscribe();
    const timer=setInterval(refresh,30000);
    window.addEventListener("online",refresh);
    return()=>{clearInterval(timer);window.removeEventListener("online",refresh);void db.removeChannel(channel);};
  },[farm,load,run]);
  return <div className="flex flex-col gap-4">
    <p className="text-sm text-sand-600">{t("chat.privacy",locale)}</p>
    <div className="flex flex-wrap gap-2">
      <DialogForm trigger={t("chat.new",locale)} title={t("chat.new",locale)} closeLabel={t("ui.close",locale)}>
        <div className="flex flex-col gap-4 p-4">
          <label className="text-sm font-medium">{t("chat.kind",locale)}
            <select className="min-h-[44px] w-full rounded-lg border border-sand-300 bg-surface px-3" value={kind} onChange={e=>setKind(e.target.value)}>
              <option value="direct">{t("chat.direct",locale)}</option><option value="group">{t("chat.group",locale)}</option>
            </select>
          </label>
          {kind==="group"?<label className="text-sm font-medium">{t("chat.titleLabel",locale)}<Input value={title} onChange={e=>setTitle(e.target.value)} maxLength={120}/></label>:null}
          <PeoplePicker farm={farm} locale={locale} selected={people} onChange={setPeople}/>
          <p className="text-sm text-sand-600">{t("chat.history",locale)}</p>
          <TaskState {...task} locale={locale}/>
          <Button loading={task.busy} disabled={!id||!people.length||(kind==="direct"&&people.length!==1)||(kind==="group"&&!title.trim())}
            onClick={()=>void task.run(async()=>{const result=await chatRequest("",{action:"create",id,farm,kind,title,people});router.push(`/chat/${result.data}`);})}>{t("chat.create",locale)}</Button>
        </div>
      </DialogForm>
      <Button variant="secondary" loading={task.busy} onClick={()=>void task.run(()=>load())}>{t("chat.refresh",locale)}</Button>
      <Link href="/work" className={buttonVariants({variant:"ghost"})}>{t("chat.jobDiscussions",locale)}</Link>
    </div>
    <TaskState {...task} locale={locale}/>
    {ready&&!rooms.length?<p className="text-sand-600">{t("chat.empty",locale)}</p>:null}
    <ul className="divide-y divide-sand-200 rounded-xl border border-sand-200 bg-surface">
      {rooms.map(room=><li key={room.id}><Link href={`/chat/${room.id}`} className="flex min-h-[60px] items-center justify-between gap-3 p-4 hover:bg-sand-50">
        <span className="min-w-0 break-words font-medium">{room.kind==="direct"?room.people.join(", ")||t("chat.direct",locale):room.title}</span>
        {room.unread>0?<span className="shrink-0 text-sm text-brand-700">{t("chat.unread",locale).replace("{count}",String(room.unread))}</span>:null}
      </Link></li>)}
    </ul>
    {more?<Button variant="secondary" loading={task.busy} onClick={()=>void task.run(()=>load(rooms.length))}>{t("chat.more",locale)}</Button>:null}
  </div>;
}
