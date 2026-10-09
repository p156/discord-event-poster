// INTERNAL ROUTER ONLY: deliberately NOT imported by the public Worker entrypoint.
import {hasAllowedHost} from './request-boundary.mjs';
import {readPostRequest,PostInputError} from './forum-input.mjs';
import {fixedDiscordConfig} from './discord-client.mjs';
import {prepareForumPost,sendPreparedForumPost} from './forum-posts.mjs';
import {UUID,payloadHash,signOperation,verifyOperation,internalProof,OperationError} from './post-keys.mjs';
function reply(body,status,origin,extra={}){return Response.json(body,{status,headers:{'Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff',...(origin?{'Access-Control-Allow-Origin':origin,'Access-Control-Expose-Headers':'Retry-After,Location'}:{}),...extra}});}
function rejected(code,status,requestId,origin,fields=[],claims){return reply({apiVersion:1,requestId,operationId:claims?.operationId||null,status:'not_accepted',replayed:false,attempt:0,expiresAt:claims?new Date(claims.expiresAt).toISOString():null,safeToRetry:false,retryAfterSeconds:null,error:{code,message:'投稿処理を完了できませんでした。',fields},result:null},status,origin);}
async function call(env,body,signed=true){
  const stub=env.AUTH_STATE.get(env.AUTH_STATE.idFromName('personal-auth-v1'));
  const packet=signed?{...body,proof:await internalProof(body,env.SESSION_SIGNING_KEY)}:body;
  const response=await stub.fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify(packet)}));
  if(!response.ok){let code=response.status===401?'SESSION_EXPIRED':'STATE_UNAVAILABLE';if(response.status!==401){const b=await response.json();if(['INVALID_OPERATION_KEY','OPERATION_EXPIRED','TARGET_CHANGED','OPERATION_EXPIRING','INVALID_REQUEST','STATE_UNAVAILABLE'].includes(b.error?.code))code=b.error.code;}throw new OperationError(code,response.status);}
  return response.json();
}
function stateReply(answer,requestId,origin,explicit){
  const r=answer.record;let status=explicit??answer.httpStatus;
  if(!status)status=r.status==='succeeded'?(r.replayed?200:201):['preparing','sending'].includes(r.status)?202:r.status==='unknown'?502:r.error?.code?.endsWith('RATE_LIMITED')?429:r.error?.code?.startsWith('TAG_')?422:r.error?.code==='SERVICE_UNAVAILABLE'?503:r.status==='failed'?502:200;
  return reply({...r,requestId},status,origin,{Location:'/api/forum/posts/'+r.operationId,...(r.retryAfterSeconds?{'Retry-After':String(r.retryAfterSeconds)}:status===202?{'Retry-After':'2'}:{})});
}
export function createPostHandler({fetchImpl,timeoutMs}={}){
  return async function handle(request,env){
    const requestId=crypto.randomUUID();let origin=null,claims,begin;
    try{
      if(!hasAllowedHost(request))return rejected('HOST_REJECTED',403,requestId,null);
      if(!request.headers.get('Origin')||request.headers.get('Origin')!==env.ALLOWED_ORIGIN)return rejected('ORIGIN_REJECTED',403,requestId,null);
      origin=env.ALLOWED_ORIGIN;const url=new URL(request.url),path=url.pathname;
      const intent=path==='/api/forum/post-intents',post=path==='/api/forum/posts',get=path.startsWith('/api/forum/posts/')&&UUID.test(path.slice('/api/forum/posts/'.length));
      if(url.search||!intent&&!post&&!get)return rejected(url.search?'INVALID_REQUEST':'ROUTE_NOT_FOUND',url.search?400:404,requestId,origin);
      if(request.method==='OPTIONS'){
        const method=request.headers.get('Access-Control-Request-Method'),hs=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
        if(method!==(get?'GET':'POST')||hs.some(x=>!['authorization','content-type','idempotency-key'].includes(x)))return rejected('ORIGIN_REJECTED',403,requestId,origin);
        return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Methods':get?'GET':'POST','Access-Control-Allow-Headers':'Authorization,Content-Type,Idempotency-Key','Cache-Control':'no-store'}});
      }
      if(request.method!==(get?'GET':'POST')){const r=rejected('METHOD_NOT_ALLOWED',405,requestId,origin);r.headers.set('Allow',get?'GET':'POST');return r;}
      const token=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9.]{1,160})$/)?.[1];
      if(!token)return rejected('SESSION_REQUIRED',401,requestId,origin);
      await call(env,{action:'check',token},false);
      if(intent){
        if(request.headers.has('Idempotency-Key'))throw new OperationError('INVALID_REQUEST');
        const p=await readPostRequest(request);fixedDiscordConfig(env);
        const {claims:c}=await call(env,{action:'post.issue',token,payloadHash:await payloadHash(p)});
        return reply({apiVersion:1,requestId,operationId:c.operationId,idempotencyKey:await signOperation(c,env.SESSION_SIGNING_KEY),issuedAt:new Date(c.issuedAt).toISOString(),expiresAt:new Date(c.expiresAt).toISOString(),payloadHash:c.payloadHash,status:'not_started'},201,origin,{Location:'/api/forum/posts/'+c.operationId});
      }
      claims=await verifyOperation(request.headers.get('Idempotency-Key'),env.SESSION_SIGNING_KEY);
      if(get){if(path.slice('/api/forum/posts/'.length)!==claims.operationId)throw new OperationError('INVALID_OPERATION_KEY');return stateReply(await call(env,{action:'post.inspect',token,claims}),requestId,origin,200);}
      const p=await readPostRequest(request);
      if(await payloadHash(p)!==claims.payloadHash)throw new OperationError('KEY_PAYLOAD_CONFLICT',409);
      const current=await call(env,{action:'post.inspect',token,claims});
      if(['not_started','retryable'].includes(current.record.status)&&claims.expiresAt-Date.now()<120000)throw new OperationError('OPERATION_EXPIRING',409);
      if(!['not_started','retryable'].includes(current.record.status)||!current.record.safeToRetry)return stateReply(current,requestId,origin);
      if(claims.forumId!==env.DISCORD_FORUM_CHANNEL_ID)throw new OperationError('TARGET_CHANGED',409);
      if(claims.expiresAt-Date.now()<120000)throw new OperationError('OPERATION_EXPIRING',409);
      const prepared=await prepareForumPost(env,p,{fetchImpl,timeoutMs});
      if(prepared.outcome!=='prepared'){const answer=await call(env,{action:'post.preflight-failure',token,claims,failure:{code:prepared.code==='FORUM_RESPONSE_INVALID'?'SERVICE_UNAVAILABLE':prepared.code,safeToRetry:prepared.safeToRetry,httpStatus:prepared.httpStatus,retry:prepared.retry}});return stateReply(answer,requestId,origin,prepared.httpStatus);}
      const reserved=await call(env,{action:'post.reserve',token,claims});
      if(!reserved.leaseId)return stateReply(reserved,requestId,origin);
      begin=await call(env,{action:'post.begin',token,claims,leaseId:reserved.leaseId});
      if(!begin.sendAllowed)return stateReply(begin,requestId,origin);
      // Durable sending + quota are confirmed. No re-acquisition/retry on lost reply.
      const outcome=await sendPreparedForumPost(prepared.context);
      try{return stateReply(await call(env,{action:'post.finish',token,claims,attemptId:begin.attemptId,outcome}),requestId,origin);}
      catch{return reply({...begin.record,requestId,status:'unknown',safeToRetry:false,error:{code:'OUTCOME_UNKNOWN',message:'投稿結果を確認できません。再送せず状態を照会してください。',fields:[]},result:null},502,origin);}
    }catch(error){
      if(begin?.sendAllowed)return reply({...begin.record,requestId,status:'unknown',safeToRetry:false,error:{code:'OUTCOME_UNKNOWN',message:'投稿結果を確認できません。再送せず状態を照会してください。',fields:[]},result:null},502,origin);
      const code=error instanceof OperationError||error instanceof PostInputError?error.code:'STATE_UNAVAILABLE';
      return rejected(code,error instanceof OperationError||error instanceof PostInputError?error.httpStatus:503,requestId,origin,error instanceof PostInputError?error.fields:[],claims);
    }
  };
}
