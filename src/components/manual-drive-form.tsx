"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { t, type Lang } from "@/lib/i18n";
import { LIMITS } from "@/lib/limits";
import { manualDriveArgs, manualDriveKey, readManualDriveDraft, type ManualDriveDraft, type ManualDriveContext } from "@/lib/manual-driving";
import { DialogActions, DialogFields, useDialogForm } from "@/components/ui/dialog-form";
import { Field } from "@/components/ui/field";
import { Input, controlBase } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Button } from "@/components/ui/button";
import { ReportPending } from "@/components/ui/pending-guard";
import { DrivingLocation } from "@/components/driving-location";

type Person={id:string;name:string};
export type ManualDriveSave=(draft:ManualDriveDraft,context:ManualDriveContext)=>Promise<{ok:boolean;reason?:"invalid"|"changed"|"forbidden"|"backwards"|"stale"}>;
export function ManualDriveForm({context,user,locale,manage,vehicles,drivers,initial,mapOn,save}: {
  context:ManualDriveContext;user:string;locale:Lang;manage:boolean;vehicles:Person[];drivers:Person[];
  initial:Partial<ManualDriveDraft>;mapOn:boolean;save:ManualDriveSave;
}) {
  const [draft,setDraft]=useState<ManualDriveDraft|null>(null),[busy,setBusy]=useState(false),[failure,setFailure]=useState<string|null>(null),[saved,setSaved]=useState(false);
  const locked=useRef(false),router=useRouter(),{close}=useDialogForm();
  const key=manualDriveKey(user,context);
  const [adoptPlan,setAdoptPlan]=useState(false);
  useEffect(()=>{
    if(!adoptPlan||!draft||initial.planVersion===undefined||draft.planVersion===initial.planVersion)return;
    const value={...draft,planVersion:initial.planVersion,destination:initial.destination??"",stops:initial.stops??""};
    setDraft(value);setAdoptPlan(false);setFailure(null);
    try{sessionStorage.setItem(key,JSON.stringify(value));}catch{}
  },[adoptPlan,draft,initial.planVersion,initial.destination,initial.stops,key]);
  // The component is keyed by user, farm, session and event kind by its parent.
  const initialRef=useRef(initial);
  useEffect(()=>{let recovered:ManualDriveDraft|null=null;try{recovered=readManualDriveDraft(sessionStorage.getItem(key));}catch{}
    setDraft(recovered??{request:crypto.randomUUID(),machine:"",driver:user,at:"",location:"",notes:"",km:"",destination:"",stops:"",lat:"",lng:"",planVersion:"0",...initialRef.current});
  },[key,user]);
  const update=(value:ManualDriveDraft)=>{setDraft(value);try{sessionStorage.setItem(key,JSON.stringify(value));}catch{}};
  useEffect(()=>{if(saved&&!busy){const timer=setTimeout(()=>{close();router.refresh();},0);return()=>clearTimeout(timer);}},[saved,busy,close,router]);
  if(!draft)return <p className="p-4">{t("manualDrive.loading",locale)}</p>;
  const field=(name:keyof ManualDriveDraft,value:string)=>update({...draft,[name]:value});
  return <form onSubmit={event=>{
    event.preventDefault();if(locked.current)return;
    const form=new FormData(event.currentTarget);
    const value={...draft,lat:mapOn?String(form.get("lat")||draft.lat):"",lng:mapOn?String(form.get("lng")||draft.lng):""};
    update(value);
    if(!manualDriveArgs(value,context)){setFailure("invalid");return;}
    locked.current=true;setBusy(true);setFailure(null);
    void save(value,context).then(result=>{if(result.ok){try{sessionStorage.removeItem(key);}catch{}setSaved(true);}else setFailure(result.reason??"invalid");})
      .catch(()=>setFailure("connection")).finally(()=>{locked.current=false;setBusy(false);});
  }}>
    <ReportPending pending={busy}/>
    <fieldset disabled={busy||saved} className="contents">
      <DialogFields>
        {context.session?<p>{drivers.find(p=>p.id===draft.driver)?.name??draft.driver} · {vehicles.find(p=>p.id===draft.machine)?.name??draft.machine}</p>:null}
        {!context.session?<>
          <Field label={t("driving.vehicle",locale)} htmlFor={`${key}-machine`}><Select id={`${key}-machine`} value={draft.machine} required onChange={e=>field("machine",e.target.value)}>
            <option value="">{t("driving.choose",locale)}</option>{vehicles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </Select></Field>
          {manage?<Field label={t("driving.driver",locale)} htmlFor={`${key}-driver`}><Select id={`${key}-driver`} value={draft.driver} onChange={e=>field("driver",e.target.value)}>{drivers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>:null}
        </>:null}
        <Field label={t("manualDrive.km",locale)} htmlFor={`${key}-km`} hint={t("manualDrive.kmHint",locale)}>
          <Input id={`${key}-km`} inputMode="decimal" value={draft.km} onChange={e=>field("km",e.target.value)} maxLength={12}/>
        </Field>
        <Field label={t("driving.location",locale)} htmlFor={`${key}-location`}><Input id={`${key}-location`} value={draft.location} maxLength={200} required={context.kind==="arrive"} onChange={e=>field("location",e.target.value)}/></Field>
        <Field label={t("manualDrive.destination",locale)} htmlFor={`${key}-destination`}><Input id={`${key}-destination`} value={draft.destination} maxLength={200} onChange={e=>field("destination",e.target.value)}/></Field>
        <Field label={t("manualDrive.stops",locale)} htmlFor={`${key}-stops`} hint={t("manualDrive.stopsHint",locale)}>
          <textarea id={`${key}-stops`} className={`${controlBase} min-h-[120px] py-3`} value={draft.stops} maxLength={LIMITS.drivingStopsTextChars.value} onChange={e=>field("stops",e.target.value)}/>
        </Field>
        {manage?<Field label={t("driving.time",locale)} htmlFor={`${key}-at`} hint={t("driving.timeHint",locale)}><Input id={`${key}-at`} type="datetime-local" value={draft.at} onChange={e=>field("at",e.target.value)}/></Field>:null}
        <Field label={t("driving.notes",locale)} htmlFor={`${key}-notes`}><Input id={`${key}-notes`} value={draft.notes} maxLength={2000} onChange={e=>field("notes",e.target.value)}/></Field>
        {mapOn&&draft.driver===user?<DrivingLocation locale={locale}/>:null}
        <p className="text-sm text-ink-muted">{t("manualDrive.draftHint",locale)}</p>
        {failure?<p role="alert" className="text-sm text-status-overdue">{t(failure==="stale"?"manualDrive.stale":failure==="changed"?"manualDrive.changed":failure==="forbidden"?"manualDrive.forbidden":failure==="backwards"?"manualDrive.backwards":"manualDrive.failed",locale)}</p>:null}
        {failure==="stale"?<Button variant="secondary" onClick={()=>{setAdoptPlan(true);router.refresh();}}>{t("manualDrive.reloadPlan",locale)}</Button>:null}
        {failure==="changed"?<Button variant="secondary" onClick={()=>{
          const value={request:crypto.randomUUID(),machine:"",driver:user,at:"",location:"",notes:"",km:"",destination:"",stops:"",lat:"",lng:"",planVersion:"0",...initial};
          update(value);setFailure(null);
        }}>{t("manualDrive.discardDraft",locale)}</Button>:null}
      </DialogFields>
      <DialogActions cancelLabel={t("common.cancel",locale)}><SubmitButton disabled={busy||saved}>{t(busy?"manualDrive.saving":"common.save",locale)}</SubmitButton></DialogActions>
    </fieldset>
  </form>;
}
