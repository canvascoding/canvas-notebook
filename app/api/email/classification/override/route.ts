import { NextRequest,NextResponse } from 'next/server';
import { updateEmailClassificationOverride } from '@/app/lib/email/classification/state-service';
import type { EmailClassificationOverride } from '@/app/lib/email/classification/types';
import { emailClassificationRouteActor,emailClassificationRouteError,emailClassificationInvalidRequest,emailClassificationRoutePayload,EMAIL_CLASSIFICATION_PRIVATE_HEADERS } from '@/app/lib/email/classification/route-support';
export const dynamic='force-dynamic';
export async function PATCH(request:NextRequest){
  const actor=await emailClassificationRouteActor(request,true,'email-classification-override');if(actor instanceof NextResponse)return actor;
  const payload=await emailClassificationRoutePayload(request,['messageRef','expectedVersion','overrides']);
  if(!payload||typeof payload.messageRef!=='string'||typeof payload.expectedVersion!=='number'||!payload.overrides)return emailClassificationInvalidRequest();
  try{return NextResponse.json({success:true,data:await updateEmailClassificationOverride({userId:actor.userId,messageRef:payload.messageRef,expectedVersion:payload.expectedVersion,overrides:payload.overrides as EmailClassificationOverride})},{headers:EMAIL_CLASSIFICATION_PRIVATE_HEADERS});}
  catch(error){return emailClassificationRouteError(error);}
}
