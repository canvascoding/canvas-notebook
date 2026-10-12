import { NextRequest,NextResponse } from 'next/server';
import { readEmailClassificationFeed } from '@/app/lib/email/classification/feed-service';
import { parseEmailMailboxScope } from '@/app/lib/email/classification/mailbox-types';
import type { EmailFeedMode,EmailFeedView } from '@/app/lib/email/classification/feed-types';
import type { EmailCategory } from '@/app/lib/email/classification/types';
import { emailClassificationRouteActor,emailClassificationRouteError,emailClassificationInvalidRequest,EMAIL_CLASSIFICATION_PRIVATE_HEADERS } from '@/app/lib/email/classification/route-support';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
  const actor=await emailClassificationRouteActor(request,false,'email-classification-feed');if(actor instanceof NextResponse)return actor;
  const query=request.nextUrl.searchParams;
  const keys=['scope','mailboxRef','mode','view','category','search','limit','cursor'];
  if([...query.keys()].some(key=>!keys.includes(key)||query.getAll(key).length!==1))return emailClassificationInvalidRequest();
  try{
    let scope;try{scope=parseEmailMailboxScope(query.get('scope'),query.get('mailboxRef'));}catch{return emailClassificationInvalidRequest();}
    const data=await readEmailClassificationFeed({userId:actor.userId,scope,mode:(query.get('mode')||undefined) as EmailFeedMode|undefined,
      view:(query.get('view')||undefined) as EmailFeedView|undefined,category:(query.get('category')||undefined) as EmailCategory|undefined,
      search:query.get('search')??undefined,limit:query.has('limit')?Number(query.get('limit')):undefined,cursor:query.get('cursor')??undefined});
    return NextResponse.json({success:true,data},{headers:EMAIL_CLASSIFICATION_PRIVATE_HEADERS});
  }catch(error){return emailClassificationRouteError(error);}
}
