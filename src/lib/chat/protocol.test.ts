import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_BODY, draftKey, mergeMessages, parseWrite, readDraft, type ChatMessage } from "./protocol";
import { readChatBody } from "./body";
import { LIMITS } from "@/lib/limits";

const id="bc300000-0000-4000-9000-000000000001",room="bc200000-0000-4000-9000-000000000001";
test("draft recovery preserves request identity and rejects corrupt or oversized storage",()=>{
  assert.deepEqual(readDraft(JSON.stringify({id,body:"unsent",secret:"ignored"})),{id,body:"unsent"});
  for(const raw of [null,"{",JSON.stringify({id:"bad",body:"x"}),JSON.stringify({id,body:"x".repeat(CHAT_BODY+1)})])assert.equal(readDraft(raw),null);
  assert.notEqual(draftKey("one",room),draftKey("two",room));
  assert.notEqual(draftKey("one",room),draftKey("one",id));
});
test("writes whitelist commands and arguments without accepting impersonation or privilege flags",()=>{
  assert.deepEqual(parseWrite({action:"send",room,id,body:"hi",sender_id:id,is_admin:true}),{rpc:"chat_send",args:{p_conversation:room,p_id:id,p_body:"hi"}});
  for(const value of [{action:"grant",room,id,body:"x"},{action:"send",room:"bad",id,body:"x"},{action:"send",room,id,body:"x".repeat(CHAT_BODY+1)},{action:"read",room,sequence:-1},{action:"read",room,sequence:Infinity},{action:"manage",room,operation:"add",person:"bad"},{action:"manage",room,operation:"rename",title:" "}])assert.equal(parseWrite(value),null);
  assert.equal(parseWrite({action:"delete",room,id,body:""})?.args.p_delete,true);
});
test("overlapping pages replace edits and deletions and retain sequence order without duplicates",()=>{
  const first:ChatMessage={id,sender_id:id,sequence:10,body:"before",published_at:"2026-11-17",edited_at:null,deleted_at:null};
  const older={...first,id:room,sequence:2};
  const deleted={...first,body:"",deleted_at:"2026-11-17"};
  assert.deepEqual(mergeMessages([first],[deleted,older]),[older,deleted]);
});
test("streamed JSON enforces received bytes without relying on Content-Length",async()=>{
  assert.deepEqual(await readChatBody(new Request("http://localhost",{method:"POST",body:JSON.stringify({body:"Goeiemôre"})})),{body:"Goeiemôre"});
  let cancelled=false;
  const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(LIMITS.chatRequestBytes.value+1));},cancel(){cancelled=true;}});
  const request=new Request("http://localhost",{method:"POST",body:stream,duplex:"half"} as RequestInit);
  await assert.rejects(readChatBody(request),RangeError);assert.equal(cancelled,true);
  await assert.rejects(readChatBody(new Request("http://localhost",{method:"POST",body:"{"})),SyntaxError);
});
