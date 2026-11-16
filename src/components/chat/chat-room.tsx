"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/client";
import { CHAT_BODY, CHAT_PAGE, draftKey, readDraft, mergeMessages, type Draft, type ChatRoom, type ChatMessage, type ChatAttachment } from "@/lib/chat/protocol";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, controlBase } from "@/components/ui/input";
import { DialogForm, useDialogForm } from "@/components/ui/dialog-form";
import { PageHeader } from "@/components/ui/page-header";
import { UploadField } from "@/components/upload/upload-field";
import { chatRequest, PeoplePicker, TaskState, useChatTask } from "./shared";

function Attachment({file,locale}:{file:ChatAttachment;locale:Lang}) {
  const [url,setUrl]=useState<string|null>(null),task=useChatTask();
  useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
  return <div className="flex flex-col gap-2">
    <Button size="sm" variant="secondary" loading={task.busy} onClick={()=>void task.run(async()=>{
      const result=await createClient().storage.from("chat-files").download(file.storage_path);
      if(result.error||!result.data)throw new Error("chat-file");
      setUrl(URL.createObjectURL(result.data));
    })}>{t("chat.openFile",locale)} ({file.media_class}, {Math.ceil(file.bytes/1000)} kB)</Button>
    <TaskState {...task} locale={locale}/>
    {url&&file.media_class==="voice"?<audio controls preload="metadata" src={url} className="max-w-full" aria-label={t("chat.voice",locale)}/>:null}
    {url?<a href={url} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand-700 underline">{t("chat.viewFile",locale)}</a>:null}
  </div>;
}
function Compose({room,user,locale,draft,setDraft,onSent}:{room:ChatRoom;user:string;locale:Lang;draft:Draft;setDraft:(d:Draft)=>void;onSent:()=>Promise<void>}) {
  const task=useChatTask(),{close}=useDialogForm();
  const [prepared,setPrepared]=useState(false),[uploadBusy,setUploadBusy]=useState(false),[attached,setAttached]=useState(0);
  const target=prepared?{kind:"chat_message" as const,id:draft.id,farmId:room.farm_id,workshopId:null}:null;
  return <div className="flex flex-col gap-4 p-4">
    <label className="text-sm font-medium">{t("chat.message",locale)}
      <textarea className={`${controlBase} min-h-[120px] py-3`} value={draft.body} maxLength={CHAT_BODY} disabled={task.busy}
        onChange={e=>setDraft({...draft,body:e.target.value})}/>
    </label>
    <p className="text-sm text-sand-600">{t("chat.draftHint",locale)}</p>
    {!prepared?<Button variant="secondary" loading={task.busy} onClick={()=>void task.run(async()=>{
      await chatRequest("",{action:"prepare",room:room.id,id:draft.id});setPrepared(true);
    })}>{t("chat.attach",locale)}</Button>:<>
      <UploadField key={`${draft.id}-document`} locale={locale} label={t("chat.photoDocument",locale)} accept="document" target={target} finish="generic"
        scope={`chat:${user}:${draft.id}:document`} uploadLabel="document" onDone={()=>setAttached(n=>n+1)}
        onStateChange={state=>setUploadBusy(["preparing","starting","sending","checking","paused"].includes(state.phase))}/>
      <UploadField key={`${draft.id}-voice`} locale={locale} label={t("chat.voice",locale)} accept="voice" target={target} finish="generic"
        scope={`chat:${user}:${draft.id}:voice`} uploadLabel="voice" onDone={()=>setAttached(n=>n+1)}
        onStateChange={state=>setUploadBusy(["preparing","starting","sending","checking","paused"].includes(state.phase))}/>
      <p className="text-sm text-sand-600">{t("chat.freeVoice",locale)}</p>
    </>}
    {attached>0?<p role="status" className="text-sm">{t("chat.attached",locale).replace("{count}",String(attached))}</p>:null}
    <TaskState {...task} locale={locale}/>
    <Button loading={task.busy} disabled={uploadBusy} onClick={()=>void task.run(async()=>{
      await chatRequest("",{action:"send",room:room.id,id:draft.id,body:draft.body});
      setDraft({id:crypto.randomUUID(),body:""});close();await onSent();
    })}>{task.busy?t("chat.sending",locale):t("chat.send",locale)}</Button>
  </div>;
}
function Manage({room,locale,onChange}:{room:ChatRoom;locale:Lang;onChange:()=>Promise<void>}) {
  const [title,setTitle]=useState(room.title),[people,setPeople]=useState<string[]>([]),task=useChatTask();
  const change=(operation:string,person?:string)=>task.run(async()=>{
    await chatRequest("",{action:"manage",room:room.id,operation,person,title});await onChange();
  });
  return <div className="flex flex-col gap-4 p-4">
    <label>{t("chat.titleLabel",locale)}<Input value={title} maxLength={120} onChange={e=>setTitle(e.target.value)}/></label>
    <Button variant="secondary" loading={task.busy} onClick={()=>void change("rename")}>{t("chat.rename",locale)}</Button>
    <p className="text-sm text-sand-600">{t("chat.history",locale)}</p>
    <PeoplePicker farm={room.farm_id} locale={locale} selected={people} onChange={setPeople}/>
    <Button loading={task.busy} onClick={()=>void task.run(async()=>{
      for(const person of people)await chatRequest("",{action:"manage",room:room.id,operation:"add",person});
      setPeople([]);await onChange();
    })}>{t("chat.addMembers",locale)}</Button>
    <ul className="flex flex-col gap-2">{room.members.map(member=><li className="flex flex-wrap items-center justify-between gap-2" key={member.id}>
      <span>{member.name}</span>{!member.admin?<Button variant="danger" size="sm" loading={task.busy} onClick={()=>void change("remove",member.id)}>{t("chat.removeMember",locale)}</Button>:null}
    </li>)}</ul><TaskState {...task} locale={locale}/>
  </div>;
}
function EditMessage({message,room,locale,onChange}:{message:ChatMessage;room:string;locale:Lang;onChange:()=>Promise<void>}) {
  const [body,setBody]=useState(message.body),task=useChatTask(),{close}=useDialogForm();
  return <div className="flex flex-col gap-3 p-4">
    <label>{t("chat.message",locale)}<textarea className={`${controlBase} min-h-[120px] py-3`} maxLength={CHAT_BODY} value={body} onChange={e=>setBody(e.target.value)}/></label>
    <TaskState {...task} locale={locale}/>
    <Button loading={task.busy} onClick={()=>void task.run(async()=>{await chatRequest("",{action:"edit",room,id:message.id,body});close();await onChange();})}>{t("common.save",locale)}</Button>
    <Button variant="danger" loading={task.busy} onClick={()=>void task.run(async()=>{await chatRequest("",{action:"delete",room,id:message.id,body:""});close();await onChange();})}>{t("chat.deleteMessage",locale)}</Button>
  </div>;
}
export function ChatRoomClient({id,user,locale}:{id:string;user:string;locale:Lang}) {
  const [room,setRoom]=useState<ChatRoom|null>(null),[messages,setMessages]=useState<ChatMessage[]>([]),[files,setFiles]=useState<ChatAttachment[]>([]);
  const [draft,setDraftState]=useState<Draft|null>(null),[more,setMore]=useState(false),[search,setSearch]=useState(""),[filter,setFilter]=useState("");
  const [denied,setDenied]=useState(false),task=useChatTask(),loading=useRef(false);
  useEffect(()=>{
    let saved:Draft|null=null;try{saved=readDraft(sessionStorage.getItem(draftKey(user,id)));}catch{}
    setDraftState(saved??{id:crypto.randomUUID(),body:""});
  },[id,user]);
  const setDraft=(value:Draft)=>{setDraftState(value);try{sessionStorage.setItem(draftKey(user,id),JSON.stringify(value));}catch{}};
  const load=useCallback(async(before=0,replace=false)=>{
    if(loading.current)return;loading.current=true;
    try{
      const result=await chatRequest(`?room=${id}&before=${before}&search=${encodeURIComponent(filter)}`);
      setRoom(result.room);setDenied(false);
      setMessages(old=>replace?mergeMessages([],result.messages):mergeMessages(old,result.messages));
      setFiles(old=>[...(replace?[]:old.filter(f=>!result.messages.some((m:ChatMessage)=>m.id===f.message_id))),...result.attachments]);
      if(before||replace)setMore(result.messages.length===CHAT_PAGE);
      if(!before&&!filter&&document.visibilityState==="visible"&&result.messages.length)
        await chatRequest("",{action:"read",room:id,sequence:Math.max(...result.messages.map((m:ChatMessage)=>m.sequence))});
    }catch(error){
      if(error instanceof Error&&error.message==="forbidden"){setRoom(null);setMessages([]);setFiles([]);setDenied(true);}
      throw error;
    }finally{loading.current=false;}
  },[id,filter]);
  useEffect(()=>{
    void task.run(()=>load(0,true));
    const db=createClient();
    const channel=db.channel(`chat:${id}`).on("postgres_changes",{event:"UPDATE",schema:"public",table:"chat_conversations",filter:`id=eq.${id}`},()=>{void task.run(()=>load());}).subscribe();
    const refresh=()=>{if(document.visibilityState==="visible")void task.run(()=>load());};
    const timer=setInterval(refresh,15000);window.addEventListener("online",refresh);document.addEventListener("visibilitychange",refresh);
    const auth=db.auth.onAuthStateChange(event=>{if(event==="SIGNED_OUT"){
      setRoom(null);setMessages([]);setFiles([]);setDraftState(null);setDenied(true);
      try{sessionStorage.removeItem(draftKey(user,id));}catch{}
    }});
    return()=>{clearInterval(timer);window.removeEventListener("online",refresh);document.removeEventListener("visibilitychange",refresh);auth.data.subscription.unsubscribe();void db.removeChannel(channel);};
  },[id,user,load,task.run]);
  const refresh=()=>load(0,true);
  return <div className="flex min-w-0 flex-col gap-4">
    <PageHeader title={room?.kind==="direct"?room.members.filter(m=>m.id!==user).map(m=>m.name).join(", ")||t("chat.direct",locale):room?.title??t("chat.title",locale)}/>
    <Link href="/chat" className={buttonVariants({variant:"ghost"})}>{t("chat.back",locale)}</Link>
    <TaskState {...task} locale={locale}/>
    {denied?<p role="alert">{t("chat.accessLost",locale)}</p>:null}
    {room?<>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" loading={task.busy} onClick={()=>void task.run(refresh)}>{t("chat.refresh",locale)}</Button>
        <DialogForm trigger={t("chat.search",locale)} title={t("chat.search",locale)} closeLabel={t("ui.close",locale)}>
          <div className="flex flex-col gap-3 p-4"><label>{t("chat.search",locale)}<Input value={search} onChange={e=>setSearch(e.target.value)} maxLength={120}/></label><Button onClick={()=>{setMessages([]);setFiles([]);setFilter(search);}}>{t("chat.search",locale)}</Button></div>
        </DialogForm>
        {room.kind==="group"&&room.can_write&&room.members.some(m=>m.id===user&&m.admin)?<DialogForm trigger={t("chat.manage",locale)} title={t("chat.manage",locale)} closeLabel={t("ui.close",locale)}><Manage room={room} locale={locale} onChange={refresh}/></DialogForm>:null}
      </div>
      {filter?<Button variant="ghost" onClick={()=>{setFilter("");setSearch("");}}>{t("chat.clearSearch",locale)}</Button>:null}
      <p className="text-sm text-sand-600">{t("chat.history",locale)}</p>
      {more&&messages.length?<Button variant="secondary" loading={task.busy} onClick={()=>void task.run(()=>load(messages[0].sequence))}>{t("chat.older",locale)}</Button>:null}
      <ol className="flex min-w-0 flex-col gap-3" aria-label={t("chat.messages",locale)}>
        {messages.map(message=><li key={message.id} className="min-w-0 rounded-xl border border-sand-200 bg-surface p-4">
          <div className="flex flex-wrap justify-between gap-2 text-xs text-sand-600"><span>{room.members.find(m=>m.id===message.sender_id)?.name??t("chat.formerMember",locale)}</span><time dateTime={message.published_at}>{new Date(message.published_at).toLocaleString(locale.startsWith("af")?"af-ZA":"en-ZA")}</time></div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sand-900 [overflow-wrap:anywhere]">{message.deleted_at?t("chat.deleted",locale):message.body}</p>
          {message.edited_at&&!message.deleted_at?<p className="text-xs text-sand-500">{t("chat.edited",locale)}</p>:null}
          {!message.deleted_at?files.filter(f=>f.message_id===message.id).map(file=><Attachment key={file.id} file={file} locale={locale}/>):null}
          {message.sender_id===user&&room.can_write&&!message.deleted_at?<DialogForm trigger={t("chat.edit",locale)} title={t("chat.edit",locale)} closeLabel={t("ui.close",locale)} triggerVariant="ghost" triggerSize="sm"><EditMessage message={message} room={id} locale={locale} onChange={refresh}/></DialogForm>:null}
        </li>)}
      </ol>
      {!messages.length?<p className="text-sand-600">{t("chat.noMessages",locale)}</p>:null}
      {room.can_write&&draft?<DialogForm trigger={t("chat.write",locale)} title={t("chat.write",locale)} closeLabel={t("ui.close",locale)}>
        <Compose key={draft.id} room={room} user={user} locale={locale} draft={draft} setDraft={setDraft} onSent={refresh}/>
      </DialogForm>:<p className="text-sm text-sand-600">{t("chat.readOnly",locale)}</p>}
    </>:null}
  </div>;
}
