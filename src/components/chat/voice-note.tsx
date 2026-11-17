"use client";
import { useEffect, useRef, useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { LIMITS, VOICE_NOTE_MAX_MS, VOICE_NOTE_MAX_BYTES } from "@/lib/limits";
import { preferredMimeType } from "@/components/assistant/offline-voice";
import { Button } from "@/components/ui/button";
import { ReportPending } from "@/components/ui/pending-guard";
import { UploadField } from "@/components/upload/upload-field";
import type { UploadTarget } from "@/lib/upload/client";
import { useChatTask } from "./shared";

/** MediaRecorder only: no assistant, transcription endpoint or paid provider is invoked. */
export function VoiceNote({target,scope,locale,onBusy,onDone}:{target:UploadTarget;scope:string;locale:Lang;onBusy:(busy:boolean)=>void;onDone:()=>void}) {
  const [recording,setRecording]=useState(false),[seconds,setSeconds]=useState(0),[file,setFile]=useState<File|null>(null),[attach,setAttach]=useState(false);
  const recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),timer=useRef<ReturnType<typeof setInterval>|null>(null),alive=useRef(true);
  const [uploadBusy,setUploadBusy]=useState(false);
  const task=useChatTask(),busy=recording||!!file||task.busy;
  useEffect(()=>{onBusy(busy);},[busy,onBusy]);
  useEffect(()=>{
    alive.current=true;
    return()=>{alive.current=false;if(timer.current)clearInterval(timer.current);if(recorder.current?.state==="recording")recorder.current.stop();stream.current?.getTracks().forEach(t=>t.stop());};
  },[]);
  useEffect(()=>{
    if(!busy)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();};window.addEventListener("beforeunload",warn);
    return()=>window.removeEventListener("beforeunload",warn);
  },[busy]);
  const stop=()=>{if(recorder.current?.state==="recording")recorder.current.stop();};
  const start=()=>task.run(async()=>{
    const audio=await navigator.mediaDevices.getUserMedia({audio:true});
    if(!alive.current){audio.getTracks().forEach(t=>t.stop());return;}
    stream.current=audio;
    try{
      const mime=preferredMimeType(),r=new MediaRecorder(audio,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:LIMITS.recorderAudioBitsPerSecond.value});
      recorder.current=r;const chunks:Blob[]=[];let bytes=0;const started=Date.now();
      r.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);bytes+=e.data.size;if(bytes>=VOICE_NOTE_MAX_BYTES)stop();}};
      r.onstop=()=>{
        if(timer.current)clearInterval(timer.current);audio.getTracks().forEach(t=>t.stop());
        if(!alive.current)return;setRecording(false);
        const type=(r.mimeType||"audio/webm").split(";")[0];
        setFile(new File(chunks,`voice-${crypto.randomUUID()}.${type==="audio/mp4"?"m4a":"webm"}`,{type}));
      };
      r.onerror=()=>{stop();audio.getTracks().forEach(t=>t.stop());};
      setSeconds(0);setRecording(true);r.start(1000);
      timer.current=setInterval(()=>{const elapsed=Date.now()-started;setSeconds(Math.floor(elapsed/1000));if(elapsed>=VOICE_NOTE_MAX_MS)stop();},250);
    }catch(error){setRecording(false);audio.getTracks().forEach(t=>t.stop());throw error;}
  });
  return <div className="flex flex-col gap-2">
    <ReportPending pending={busy}/>
    {!recording&&!file?<Button variant="secondary" loading={task.busy} onClick={()=>void start()}>{t("chat.record",locale)}</Button>:null}
    {task.error?<p role="alert" className="text-sm text-status-overdue">{t("chat.recordFailed",locale)}</p>:null}
    {recording?<><p role="status">{t("chat.recording",locale).replace("{seconds}",String(seconds))}</p>
      {seconds*1000>=VOICE_NOTE_MAX_MS-LIMITS.recordingWarnBeforeMs.value?<p role="status">{t("chat.recordingWarning",locale)}</p>:null}
      <Button onClick={stop}>{t("chat.stop",locale)}</Button></>:null}
    {file?<div className="flex flex-wrap gap-2">{!attach?<Button onClick={()=>setAttach(true)}>{t("chat.saveVoice",locale)}</Button>:null}
      <Button variant="ghost" disabled={uploadBusy} onClick={()=>{setFile(null);setAttach(false);}}>{t("chat.discardVoice",locale)}</Button></div>:null}
    {file&&attach?<UploadField locale={locale} accept="voice" file={file} target={target} scope={scope} finish="generic" uploadLabel="voice"
      onStateChange={state=>setUploadBusy(["preparing","starting","sending","checking","paused"].includes(state.phase))}
      onDone={()=>{setFile(null);setAttach(false);onDone();}}/>:null}
  </div>;
}
