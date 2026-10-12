import { NextRequest,NextResponse } from 'next/server';
import { readEmailClassificationMessage } from '@/app/lib/email/classification/state-service';
import { emailClassificationRouteActor,emailClassificationRouteError,emailClassificationInvalidRequest,EMAIL_CLASSIFICATION_PRIVATE_HEADERS } from '@/app/lib/email/classification/route-support';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
  const actor=await emailClassificationRouteActor(request,false,'email-classification-message');if(actor instanceof NextResponse)return actor;
  const query=request.nextUrl.searchParams;
  if([...query.keys()].some(key=>key!=='messageRef')||query.getAll('messageRef').length!==1)return emailClassificationInvalidRequest();
  try{return NextResponse.json({success:true,data:await readEmailClassificationMessage({userId:actor.userId,messageRef:query.get('messageRef')!})},{headers:EMAIL_CLASSIFICATION_PRIVATE_HEADERS});}
  catch(error){return emailClassificationRouteError(error);}
}
