import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { emailClassificationFeedErrorDetails } from './state-service';

export const EMAIL_CLASSIFICATION_PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };
export async function emailClassificationRouteActor(request: NextRequest, mutation: boolean, keyPrefix: string): Promise<{userId:string}|NextResponse> {
  const session=await auth.api.getSession({headers:request.headers});
  if (!session) return NextResponse.json({success:false,error:'Unauthorized'},{status:401,headers:EMAIL_CLASSIFICATION_PRIVATE_HEADERS});
  if (mutation) {
    const origin=requireTrustedMutationOrigin(request);
    if (!origin.ok) { origin.response.headers.set('Cache-Control',EMAIL_CLASSIFICATION_PRIVATE_HEADERS['Cache-Control']); return origin.response; }
  }
  const limited=rateLimit(request,{limit:mutation?45:90,windowMs:60_000,keyPrefix,verifiedUserId:session.user.id});
  if (!limited.ok) { limited.response.headers.set('Cache-Control',EMAIL_CLASSIFICATION_PRIVATE_HEADERS['Cache-Control']); return limited.response; }
  return {userId:session.user.id};
}
export function emailClassificationRouteError(error:unknown): NextResponse {
  const details=emailClassificationFeedErrorDetails(error);
  return NextResponse.json({success:false,code:details.code,error:details.message},{status:details.status,headers:EMAIL_CLASSIFICATION_PRIVATE_HEADERS});
}
export function emailClassificationInvalidRequest(): NextResponse {
  return NextResponse.json({success:false,code:'INVALID_EMAIL_REQUEST',error:'The email request is invalid.'},{status:400,headers:EMAIL_CLASSIFICATION_PRIVATE_HEADERS});
}
export async function emailClassificationRoutePayload(request:NextRequest,keys:string[]):Promise<Record<string,unknown>|null> {
  try {
    const text=await request.text(); if(text.length>16_000)return null;
    const payload:unknown=JSON.parse(text);
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!keys.includes(key)))return null;
    return payload as Record<string,unknown>;
  }catch{return null;}
}
