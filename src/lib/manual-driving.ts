import { isUuid, isIsoDate } from "@/lib/ids";
import { LIMITS } from "@/lib/limits";

export type ManualDriveDraft={request:string;machine:string;driver:string;at:string;location:string;notes:string;km:string;destination:string;stops:string;lat:string;lng:string};
export type ManualDriveContext={farm:string;kind:"start"|"arrive"|"depart"|"end";session:string|null};
export function manualDriveKey(user:string,context:ManualDriveContext){return `fw-driving:${user}:${context.farm}:${context.session??"new"}:${context.kind}`;}
export function readManualDriveDraft(raw:string|null):ManualDriveDraft|null {
  try{const value=JSON.parse(raw??"null");
    if(!value||!isUuid(value.request))return null;
    if(!["machine","driver","at","location","notes","km","destination","stops","lat","lng"].every(key=>typeof value[key]==="string"))return null;
    if(value.notes.length>2000||value.location.length>200||value.destination.length>200||value.stops.length>LIMITS.drivingStopsTextChars.value)return null;
    return value as ManualDriveDraft;
  }catch{return null;}
}
export function manualDriveArgs(draft:ManualDriveDraft,context:ManualDriveContext):Record<string,unknown>|null {
  if(!isUuid(draft.request)||!isUuid(context.farm)||!isUuid(draft.machine)||!isUuid(draft.driver)
    ||!["start","arrive","depart","end"].includes(context.kind)
    ||(context.kind==="start"?context.session!==null:!isUuid(context.session)))return null;
  const km=draft.km.trim().replace(",",".");
  if(Boolean(draft.lat)!==Boolean(draft.lng)||(draft.lat&&(!Number.isFinite(Number(draft.lat))||Math.abs(Number(draft.lat))>90||!Number.isFinite(Number(draft.lng))||Math.abs(Number(draft.lng))>180)))return null;
  if(km&&(!/^\d+(\.\d)?$/.test(km)||Number(km)>LIMITS.drivingMaxKm.value))return null;
  if(draft.location.length>200||draft.notes.length>2000||draft.destination.length>200||draft.stops.length>LIMITS.drivingStopsTextChars.value)return null;
  const stops=draft.stops.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(stops.length>LIMITS.drivingStops.value||stops.some(s=>s.length>200))return null;
  let at:string|null=null;
  if(draft.at){
    if(!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.at)||!isIsoDate(draft.at.slice(0,10)))return null;
    at=new Date(`${draft.at}:00+02:00`).toISOString();
  }
  return {p_request:draft.request,p_farm:context.farm,p_machine:draft.machine,p_driver:draft.driver,p_kind:context.kind,
    p_session:context.session,p_at:at,p_location:draft.location,p_notes:draft.notes,p_km:km?Number(km):null,
    p_destination:draft.destination,p_stops:stops,p_lat:draft.lat?Number(draft.lat):null,p_lng:draft.lng?Number(draft.lng):null};
}
export function drivingDistance(start:number|null,end:number|null):number|null {
  return start!==null&&end!==null&&Number.isFinite(start)&&Number.isFinite(end)&&end>=start?Math.round((end-start)*10)/10:null;
}
