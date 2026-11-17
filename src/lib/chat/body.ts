import { LIMITS } from "@/lib/limits";

/** Stop receiving oversized JSON even when Content-Length is absent or untrue. */
export async function readChatBody(request: Request): Promise<unknown> {
  const limit=LIMITS.chatRequestBytes.value;
  if(Number(request.headers.get("content-length"))>limit)throw new RangeError("chat-invalid");
  const reader=request.body?.getReader();
  if(!reader)throw new SyntaxError("chat-invalid");
  const chunks:Uint8Array[]=[];let length=0;
  try {
    while(true){
      const {done,value}=await reader.read();if(done)break;
      length+=value.byteLength;
      if(length>limit){await reader.cancel();throw new RangeError("chat-invalid");}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
