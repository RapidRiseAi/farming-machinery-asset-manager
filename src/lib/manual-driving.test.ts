import assert from "node:assert/strict";
import test from "node:test";
import {drivingDistance,manualDriveArgs,manualDriveKey,readManualDriveDraft,type ManualDriveDraft} from "./manual-driving";
const id="db000000-0000-4000-9000-000000000001";
const context={farm:id,kind:"start" as const,session:null};
const draft:ManualDriveDraft={request:id,machine:id,driver:id,at:"",location:"",notes:"",km:"0",destination:"Mill",stops:"  Depot\r\nMill\n",lat:"",lng:"",planVersion:"0"};
test("manual kilometre log preserves stop order, decimal commas, unknown time and zero",()=>{
  const args=manualDriveArgs(draft,context)!;
  assert.deepEqual(args.p_stops,["Depot","Mill"]);assert.equal(args.p_at,null);assert.equal(args.p_km,0);
  assert.equal(manualDriveArgs({...draft,km:"125,7"},context)?.p_km,125.7);
  assert.equal(manualDriveArgs({...draft,km:""},context)?.p_km,null);
  assert.equal(manualDriveArgs({...draft,at:"2026-11-17T10:20"},context)?.p_at,"2026-11-17T08:20:00.000Z");
});
test("invalid kilometres, timestamps, long stops, invalid coordinates and foreign shapes are rejected",()=>{
  for(const km of ["-1","NaN","Infinity","1e3","10.12","1000000000","2,1.0"])assert.equal(manualDriveArgs({...draft,km},context),null);
  for(const at of ["2026-02-30T10:20","2026-11-17T25:00","hello"])assert.equal(manualDriveArgs({...draft,at},context),null);
  assert.equal(manualDriveArgs({...draft,stops:Array(51).fill("stop").join("\n")},context),null);
  assert.equal(manualDriveArgs({...draft,stops:"x".repeat(201)},context),null);
  assert.equal(manualDriveArgs({...draft,lat:"NaN",lng:"20"},context),null);
  assert.equal(manualDriveArgs(draft,{...context,kind:"end"}),null);
});
test("distance is unknown with a missing reading, never fabricated as zero",()=>{
  assert.equal(drivingDistance(null,120),null);assert.equal(drivingDistance(100,null),null);
  assert.equal(drivingDistance(100,99),null);assert.equal(drivingDistance(100,100),0);
  assert.equal(drivingDistance(100.1,120.3),20.2);
});
test("drafts keep retry identity and are partitioned by person, farm, session and event",()=>{
  assert.deepEqual(readManualDriveDraft(JSON.stringify(draft)),draft);
  assert.equal(readManualDriveDraft("{"),null);assert.equal(readManualDriveDraft(JSON.stringify({...draft,request:"bad"})),null);
  assert.notEqual(manualDriveKey("one",context),manualDriveKey("two",context));
  assert.notEqual(manualDriveKey("one",context),manualDriveKey("one",{...context,kind:"arrive",session:id}));
});
