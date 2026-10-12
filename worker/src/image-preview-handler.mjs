import {officialPolicy} from './official-image-policy.mjs';
import {hasAllowedHost} from './request-boundary.mjs';
import {readPostRequest,validatePostPayload,PostInputError} from './forum-input.mjs';
import {OperationError,internalProof} from './post-keys.mjs';
import {createPreviewClaims,signPreview,verifyPreview,matchPreview} from './image-preview-ticket.mjs';
import {findOfficialImage,fetchThumbnail} from './official-image-fetch.mjs';
const headers=origin=>({'Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':origin,'Access-Control-Expose-Headers':'Retry-After'});
export async function imageCall(env,body,signed=true){const stub=env.AUTH_STATE.get(env.AUTH_STATE.idFromName('personal-auth-v1'));const packet=signed?{...body,proof:await internalProof(body,env.SESSION_SIGNING_KEY)}:body;const r=await stub.fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify(packet)}));if(!r.ok){const b=await r.json();throw new OperationError(r.status===401?'SESSION_EXPIRED':b.error?.code||'STATE_UNAVAILABLE',r.status);}return r.json();}
const keys=(v,allowed)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw new PostInputError();return v;};
export function validateIntent(v){const {previewTicket,...p}=keys(v,['apiVersion','threadName','content','tagIds','officialUrl','imageUrl','previewTicket']);const payload=validatePostPayload(p);if(payload.apiVersion===1){if(previewTicket!==undefined)throw new PostInputError();}else if(typeof previewTicket!=='string'||previewTicket.length>8192)throw new PostInputError();return {payload,previewTicket};}
export function createImagePreviewHandler(options={}){return async(request,env)=>{
 let origin=null,token,lease;
 const response=(body,status=200)=>Response.json(body,{status,headers:{...(origin?headers(origin):{'Cache-Control':'no-store'}),...(status===429?{'Retry-After':'60'}:{})}});
 try{
  if(!hasAllowedHost(request)||request.headers.get('Origin')!==env.ALLOWED_ORIGIN)return response({error:{code:'ORIGIN_REJECTED'}},403);origin=env.ALLOWED_ORIGIN;
  const u=new URL(request.url);if(u.search)throw new PostInputError();const thumbnail=u.pathname==='/api/forum/image-thumbnail';if(!thumbnail&&u.pathname!=='/api/forum/image-preview')throw new OperationError('ROUTE_NOT_FOUND',404);
  if(env.FORUM_POSTS_ENABLED!=='true')throw new OperationError('ROUTE_NOT_FOUND',404);
  if(request.method==='OPTIONS'){const hs=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);if(request.headers.get('Access-Control-Request-Method')!=='POST'||hs.some(h=>!['authorization','content-type'].includes(h)))throw new OperationError('ORIGIN_REJECTED',403);return new Response(null,{status:204,headers:{...headers(origin),'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Authorization,Content-Type'}});}
  if(request.method!=='POST')throw new OperationError('METHOD_NOT_ALLOWED',405);
  token=request.headers.get('Authorization')?.match(/^Bearer (oauth2\.[a-f0-9.]{1,160})$/)?.[1];if(!token)throw new OperationError('SESSION_REQUIRED',401);
  await imageCall(env,{action:'check',token},false);
  const raw=await readPostRequest(request,{validate:v=>v});let p,previous;
  if(thumbnail){keys(raw,['previewTicket']);previous=await verifyPreview(raw.previewTicket,env.SESSION_SIGNING_KEY);if(previous.forumId!==env.DISCORD_FORUM_CHANNEL_ID||!previous.imageUrl)throw new OperationError('INVALID_PREVIEW_TICKET',409);await imageCall(env,{action:'image.check',token,ticketId:previous.ticketId});}
  else{keys(raw,['apiVersion','threadName','content','tagIds','officialUrl','previewTicket','withoutImage']);const {previewTicket,withoutImage,...base}=raw;p=validatePostPayload({...base,imageUrl:null});if(p.apiVersion!==2)throw new PostInputError();if(previewTicket!==undefined||withoutImage!==undefined){if(withoutImage!==true||typeof previewTicket!=='string')throw new PostInputError();previous=await verifyPreview(previewTicket,env.SESSION_SIGNING_KEY);await matchPreview(previous,{...p,imageUrl:previous.imageUrl},env);}}
  if(thumbnail||!previous&&officialPolicy(p.officialUrl))lease=(await imageCall(env,{action:'image.reserve',token})).leaseId;
  if(thumbnail){let result;try{result=await fetchThumbnail(previous.officialUrl,previous.imageUrl,options);}catch{return response({error:{code:'THUMBNAIL_UNAVAILABLE'}},422);}await imageCall(env,{action:'image.check',token,ticketId:previous.ticketId});return new Response(result.bytes,{headers:{...headers(origin),'Content-Type':result.mime,'Content-Security-Policy':"default-src 'none'; sandbox"}});}
  const result=previous?{imageUrl:null,source:null,reasonCode:'THUMBNAIL_UNAVAILABLE'}:await findOfficialImage(p.officialUrl,options);
  // Recheck current session after external fetch. Register before returning ticket.
  const c=await createPreviewClaims(p,result,env.DISCORD_FORUM_CHANNEL_ID);const previewTicket=await signPreview(c,env.SESSION_SIGNING_KEY);
  await imageCall(env,{action:'image.register',token,preview:c,...(previous?{replaceId:previous.ticketId}:{})});
  return response({apiVersion:2,status:result.imageUrl?'image':'no_image',officialUrl:p.officialUrl,...result,previewTicket,expiresAt:c.expiresAt});
 }catch(e){return response({error:{code:e instanceof OperationError||e instanceof PostInputError?e.code:'STATE_UNAVAILABLE'}},e instanceof OperationError||e instanceof PostInputError?e.httpStatus:503);}
 finally{if(lease)try{await imageCall(env,{action:'image.release',token,leaseId:lease});}catch{/* Lease expires even after logout/storage failure. */}}
};}
