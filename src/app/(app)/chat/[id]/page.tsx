import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { isUuid } from "@/lib/upload/protocol";
import { PageContainer } from "@/components/ui/page-header";
import { ChatRoomClient } from "@/components/chat/chat-room";
export default async function ChatRoomPage({params}:{params:Promise<{id:string}>}) {
  const profile=await requireProfile(),{id}=await params;
  if(!isUuid(id))notFound();
  return <PageContainer><ChatRoomClient key={`${profile.id}:${id}`} id={id} user={profile.id} locale={profile.lang}/></PageContainer>;
}
