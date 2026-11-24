import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { sameOrigin } from "@/lib/security/same-origin";
import { isUuid } from "@/lib/upload/protocol";
import { CHAT_PAGE, parseWrite } from "@/lib/chat/protocol";
import { readChatBody } from "@/lib/chat/body";
import { captureError } from "@/lib/observability";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
const answer = (data: unknown, status = 200) => NextResponse.json(data,{status,headers});
function failure(error: { code?: string; message?: string } | null) {
  if (error?.code === "42501") return answer({error:"forbidden"},403);
  captureError(new Error("Chat operation failed"),{where:"chat",extra:{code:error?.code??null}});
  return answer({error:"chat-failed"},400);
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return answer({error:"forbidden"},403);
  if (!(await getProfile())?.active) return answer({error:"forbidden"},401);
  // Bound the JSON body before parsing; no message text reaches logs.
  let command;
  try { command = parseWrite(await readChatBody(request)); } catch(error) { return answer({error:"chat-invalid"},error instanceof RangeError?413:400); }
  if (!command) return answer({error:"chat-invalid"},400);
  const db=await createClient();
  const {data,error}=await db.rpc(command.rpc,command.args);
  return error?failure(error):answer({data});
}
export async function GET(request: Request) {
  if (!(await getProfile())?.active) return answer({error:"forbidden"},401);
  const url=new URL(request.url), db=await createClient();
  const farm=url.searchParams.get("farm"), room=url.searchParams.get("room");
  const offset=Number(url.searchParams.get("offset")??0);
  if (!Number.isSafeInteger(offset)||offset<0) return answer({error:"chat-invalid"},400);
  if (isUuid(farm)) {
    const {data,error}=url.searchParams.has("people")
      ?await db.rpc("chat_people",{p_farm:farm,p_search:url.searchParams.get("search")??"",p_offset:offset})
      :await db.rpc("chat_list",{p_farm:farm,p_offset:offset});
    return error?failure(error):answer({data});
  }
  if (!isUuid(room)) return answer({error:"chat-invalid"},400);
  const roomResult=await db.rpc("chat_room",{p_conversation:room});
  if(roomResult.error)return failure(roomResult.error);
  const draft=url.searchParams.get("draft");
  if(isUuid(draft)) {
    const message=await db.from("chat_messages").select("id").eq("conversation_id",room).eq("id",draft).is("published_at",null).maybeSingle();
    if(message.error)return failure(message.error);
    const result=message.data?await db.from("chat_attachments").select("id,message_id,storage_path,media_class,mime,bytes").eq("message_id",draft):{data:[],error:null};
    return result.error?failure(result.error):answer({attachments:result.data??[]});
  }
  let query=db.from("chat_messages").select("id,sender_id,sequence,body,published_at,edited_at,deleted_at")
    .eq("conversation_id",room).not("published_at","is",null).order("sequence",{ascending:false}).limit(CHAT_PAGE);
  const before=Number(url.searchParams.get("before")??0);
  if(before>0 && Number.isSafeInteger(before))query=query.lt("sequence",before);
  const search=url.searchParams.get("search")?.slice(0,120);
  if(search)query=query.ilike("body",`%${search.replace(/[\\%_]/g,"\\$&")}%`).is("deleted_at",null);
  const messages=await query;
  if(messages.error)return failure(messages.error);
  const ids=(messages.data??[]).map(m=>m.id);
  const attachments=ids.length?await db.from("chat_attachments").select("id,message_id,storage_path,media_class,mime,bytes").in("message_id",ids):{data:[],error:null};
  if(attachments.error)return failure(attachments.error);
  return answer({room:roomResult.data,messages:messages.data??[],attachments:attachments.data??[]});
}
