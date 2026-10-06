import { NextRequest,NextResponse } from 'next/server';
import { setEmailClassificationPersonalFocus } from '@/app/lib/email/classification/state-service';
import { emailClassificationRouteActor,emailClassificationRouteError,emailClassificationInvalidRequest,emailClassificationRoutePayload,EMAIL_CLASSIFICATION_PRIVATE_HEADERS } from '@/app/lib/email/classification/route-support';
export const dynamic='force-dynamic';
export async function PATCH(request:NextRequest){
  const actor=await emailClassificationRouteActor(request,true,'email-classification-focus');if(actor instanceof NextResponse)return actor;
  const payload=await emailClassificationRoutePayload(request,['messageRef','expectedVersion','done']);
  if(!payload||typeof payload.messageRef!=='string'||typeof payload.expectedVersion!=='number'||typeof payload.done!=='boolean')return emailClassificationInvalidRequest();
  try{return NextResponse.json({success:true,data:await setEmailClassificationPersonalFocus({userId:actor.userId,messageRef:payload.messageRef,expectedVersion:payload.expectedVersion,done:payload.done})},{headers:EMAIL_CLASSIFICATION_PRIVATE_HEADERS});}
  catch(error){return emailClassificationRouteError(error);}
}
