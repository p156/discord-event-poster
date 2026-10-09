import {RETENTION_MS,PRINCIPAL,OperationError,canonicalClaims,validateClaims} from './post-keys.mjs';
import {isSnowflake} from './forum-input.mjs';
import {cooldownWait} from './discord-cooldown-state.mjs';
const recordKey=id=>'posts:operation:'+id;
const expiryKey=r=>'posts:expiry:'+String(r.expiresAt).padStart(13,'0')+':'+r.operationId;
const rateKey='posts:rate';
const error=code=>({code,message:'投稿処理を完了できませんでした。',fields:[]});
export async function scheduleEarlier(storage,at){const current=await storage.getAlarm?.();if(!current||current>at)await storage.setAlarm(at);}
export async function cleanupPosts(storage,now){
  const due=await storage.list({prefix:'posts:expiry:',end:'posts:expiry:'+String(now).padStart(13,'0')+':\uffff',limit:100});
  for(const [k,id]of due){await storage.delete(recordKey(id));await storage.delete(k);}
  const first=await storage.list({prefix:'posts:expiry:',limit:1});
  if(first.size){const at=Number(first.keys().next().value.split(':')[2]);await scheduleEarlier(storage,Math.max(now+1,at));}
}
function refresh(r,now){
  if(r.status==='preparing'&&now>=r.leaseUntil){r.status='retryable';r.error=error('PREPARATION_EXPIRED');r.safeToRetry=true;r.leaseId=null;r.updatedAt=now;}
  if(r.status==='sending'&&now>=r.sendDeadline){r.status='unknown';r.error=error('OUTCOME_UNKNOWN');r.safeToRetry=false;r.updatedAt=now;}
  return r;
}
function view(r,now,replayed=true){const wait=Math.max(0,(r.nextAllowedAt||0)-now);return {apiVersion:1,operationId:r.operationId,status:r.status,replayed,attempt:r.attempt,expiresAt:new Date(r.expiresAt).toISOString(),safeToRetry:['not_started','retryable'].includes(r.status)&&r.safeToRetry!==false&&wait===0&&r.expiresAt-now>=120000,retryAfterSeconds:wait?Math.ceil(wait/1000):null,error:r.error||null,result:r.result||null};}
function matches(r,c){return canonicalClaims(r.claims)===canonicalClaims(c);}
function cleanResult(result,r){
  const ids=['guildId','forumId','threadId','messageId'];if(!result||ids.some(k=>!isSnowflake(result[k]))||result.forumId!==r.claims.forumId)throw new OperationError('STATE_UNAVAILABLE',503);
  const {guildId,forumId,threadId,messageId}=result;return {guildId,forumId,threadId,messageId,threadUrl:'https://discord.com/channels/'+guildId+'/'+threadId,url:'https://discord.com/channels/'+guildId+'/'+threadId+'/'+messageId};
}
// Called only inside the existing AuthState queue. No network calls in transactions.
export async function postState(storage,env,input,now=Date.now()){
  await cleanupPosts(storage,now);
  const c=input.action==='post.issue'?validateClaims({v:1,operationId:crypto.randomUUID(),principal:PRINCIPAL,forumId:env.DISCORD_FORUM_CHANNEL_ID,payloadHash:input.payloadHash,issuedAt:now,expiresAt:now+RETENTION_MS}):validateClaims(input.claims);
  if(now>=c.expiresAt)throw new OperationError('OPERATION_EXPIRED',410);
  if(now<c.issuedAt)throw new OperationError('INVALID_OPERATION_KEY');
  if(input.action==='post.issue'){
    if(c.principal!==PRINCIPAL||c.forumId!==env.DISCORD_FORUM_CHANNEL_ID||c.expiresAt-c.issuedAt!==RETENTION_MS)throw new OperationError('TARGET_CHANGED',409);
    const r={claims:c,operationId:c.operationId,createdAt:c.issuedAt,updatedAt:c.issuedAt,expiresAt:c.expiresAt,status:'not_started',attempt:0,safeToRetry:true,nextAllowedAt:0,leaseId:null,result:null,error:null};
    await storage.transaction(async tx=>{if(await tx.get(recordKey(c.operationId)))throw new OperationError('INVALID_OPERATION_KEY');await tx.put(recordKey(c.operationId),r);await tx.put(expiryKey(r),r.operationId);});
    await scheduleEarlier(storage,r.expiresAt);await storage.sync();return {record:view(r,now,false),claims:c};
  }
  const answer=await storage.transaction(async tx=>{
    now=Date.now(); // Re-evaluate time if a transaction callback is delayed/retried.
    if(now>=c.expiresAt)throw new OperationError('OPERATION_EXPIRED',410);
    if(now<c.issuedAt)throw new OperationError('INVALID_OPERATION_KEY');
    const key=recordKey(c.operationId);let r=await tx.get(key);if(!r)throw new OperationError('STATE_UNAVAILABLE',503);
    if(!matches(r,c))throw new OperationError('INVALID_OPERATION_KEY');
    r=refresh(r,now);
    if(input.action!=='post.inspect'&&c.forumId!==env.DISCORD_FORUM_CHANNEL_ID&&input.action!=='post.finish')throw new OperationError('TARGET_CHANGED',409);
    if(input.action==='post.inspect'){
      const cooldown=await cooldownWait(tx,{route:'POST channel/threads',major:'channel:'+c.forumId},now);
      if(['not_started','retryable'].includes(r.status)&&cooldown){r.nextAllowedAt=Math.max(r.nextAllowedAt||0,now+cooldown.retryAfterSeconds*1000);r.error=error('DISCORD_RATE_LIMITED');}
      await tx.put(key,r);return {record:view(r,now)};
    }
    if(input.action==='post.reserve'){
      if(!['not_started','retryable'].includes(r.status)||r.safeToRetry===false)return {record:view(r,now)};
      if(r.expiresAt-now<120000)throw new OperationError('OPERATION_EXPIRING',409);
      if((r.nextAllowedAt||0)>now)return {record:view(r,now),httpStatus:r.error?.code==='DISCORD_RATE_LIMITED'?429:202};
      r.status='preparing';r.leaseId=crypto.randomUUID();r.leaseUntil=now+15000;r.updatedAt=now;r.error=null;
      await tx.put(key,r);return {record:view(r,now),leaseId:r.leaseId,leaseUntil:r.leaseUntil};
    }
    if(input.action==='post.begin'){
      if(r.status!=='preparing'||r.leaseId!==input.leaseId||now>=r.leaseUntil)return {record:view(r,now)};
      const [sessionId,expiry]=input.token.split('.'),sessions=await tx.get('sessions')||[];
      if(Number(expiry)<=Date.now()||!sessions.some(s=>s.id===sessionId&&s.expires===Number(expiry)))throw new OperationError('SESSION_EXPIRED',401);
      now=Date.now();
      if(now>=r.leaseUntil)return {record:view(refresh(r,now),now)};
      if(r.expiresAt-now<120000)throw new OperationError('OPERATION_EXPIRING',409);
      let rate=await tx.get(rateKey);const marker=await tx.get('posts:rate-initialized');
      if(Boolean(rate)!==Boolean(marker))throw new OperationError('STATE_UNAVAILABLE',503);
      rate=rate||{slots:[],lastNow:0};const t=Math.max(now,rate.lastNow);rate.lastNow=t;rate.slots=rate.slots.filter(x=>x>t-60000);
      const cooldown=await cooldownWait(tx,{route:'POST channel/threads',major:'channel:'+c.forumId},t);
      const code=cooldown?'DISCORD_RATE_LIMITED':rate.slots.length>=10?'APP_RATE_LIMITED':null;
      if(code){r.status='retryable';r.safeToRetry=true;r.error=error(code);r.nextAllowedAt=code==='APP_RATE_LIMITED'?rate.slots[0]+60000:t+cooldown.retryAfterSeconds*1000;r.updatedAt=now;r.leaseId=null;await tx.put(key,r);await tx.put('posts:rate-initialized',true);await tx.put(rateKey,rate);return {record:view(r,t),httpStatus:429};}
      rate.slots.push(t);r.status='sending';r.attempt++;r.attemptId=r.leaseId;r.leaseId=null;r.sendDeadline=now+120000;r.updatedAt=now;r.safeToRetry=false;r.nextAllowedAt=0;
      await tx.put('posts:rate-initialized',true);await tx.put(rateKey,rate);await tx.put(key,r);return {record:view(r,now,false),sendAllowed:true,attemptId:r.attemptId};
    }
    if(input.action==='post.preflight-failure'){
      // A failed concurrent preflight must never overwrite sending/success.
      if(!['not_started','retryable'].includes(r.status))return {record:view(r,now)};
      const f=input.failure;const allowed=['TAG_INVALID','TAG_REQUIRED','TAG_PERMISSION_UNVERIFIED','CONTENT_INVALID','SERVICE_UNAVAILABLE','DISCORD_REQUEST_REJECTED','DISCORD_CREDENTIAL_REJECTED','DISCORD_PERMISSION_DENIED','DISCORD_TARGET_UNAVAILABLE','DISCORD_RATE_LIMITED'];
      if(!f||!allowed.includes(f.code))throw new OperationError('STATE_UNAVAILABLE',503);
      r.status=f.safeToRetry?'retryable':'failed';r.safeToRetry=Boolean(f.safeToRetry);r.error=error(f.code);r.updatedAt=now;
      if(f.code==='DISCORD_RATE_LIMITED'){await saveCooldown(tx,r,f.retry,now);r.safeToRetry=f.retry?.automaticRetryAllowed===true;}
      await tx.put(key,r);return {record:view(r,now,false),httpStatus:f.httpStatus};
    }
    if(input.action==='post.finish'){
      if(r.attemptId!==input.attemptId||!['sending','unknown'].includes(r.status))return {record:view(r,now)};
      const f=input.outcome;
      if(f?.outcome==='succeeded'){r.status='succeeded';r.result=cleanResult(f.result,r);r.error=null;}
      else if(r.status==='unknown')return {record:view(r,now)}; // Only a valid late receipt may resolve unknown.
      else if(f?.code==='DISCORD_RATE_LIMITED'&&f.outcome==='rejected'){
        await saveCooldown(tx,r,f.retry,now);r.status='retryable';r.safeToRetry=f.retry?.automaticRetryAllowed===true&&r.attempt<4;r.error=error('DISCORD_RATE_LIMITED');
      }else if(f?.outcome==='rejected'&&['DISCORD_REQUEST_REJECTED','DISCORD_CREDENTIAL_REJECTED','DISCORD_PERMISSION_DENIED','DISCORD_TARGET_UNAVAILABLE'].includes(f.code)){r.status='failed';r.error=error(f.code);r.safeToRetry=false;}
      else {r.status='unknown';r.error=error('OUTCOME_UNKNOWN');r.safeToRetry=false;}
      r.updatedAt=now;await tx.put(key,r);return {record:view(r,now,false)};
    }
    throw new OperationError('INVALID_REQUEST');
  });
  await storage.sync();return answer;
}
async function saveCooldown(tx,r,retry,now){
  const seconds=typeof retry?.retryAfterSeconds==='number'&&Number.isFinite(retry.retryAfterSeconds)&&retry.retryAfterSeconds>0?retry.retryAfterSeconds:60;
  // Fixed 250ms safety margin; never truncate an upstream wait to 60 seconds.
  const until=Math.min(Number.MAX_SAFE_INTEGER,now+Math.ceil(seconds*1000)+250);
  r.nextAllowedAt=Math.max(r.nextAllowedAt||0,until); // Per-operation wait; shared scopes are recorded by the transport.
}
