import {OperationError} from './post-keys.mjs';
const key='discord:cooldowns';
export function validateScope(scope){
  if(!scope||!['GET channel','GET channel/webhooks','POST channel/threads','GET users/@me','GET guild/roles','GET guild/member'].includes(scope.route)||!(/^(?:channel|guild):[1-9]\d{0,19}$/.test(scope.major)||scope.major==='none'))throw new OperationError('INVALID_REQUEST');
  return scope.route+'|'+scope.major;
}
export async function cooldownWait(storage,scope,now=Date.now()){
  const route=validateScope(scope),state=await storage.get(key)||{};
  const legacy=await storage.get('posts:cooldown');
  // Preserve an explicit global wait recorded by the earlier internal implementation.
  const legacyUntil=legacy&&(legacy.global===true||legacy.scope==='global')?legacy.until||0:0;
  const t=Math.max(now,state.lastNow||0),bucket=state.routeBuckets?.[route];
  const globalUntil=Math.max(state.globalUntil||0,legacyUntil),until=Math.max(globalUntil,state.routes?.[route]||0,bucket?state.buckets?.[bucket+'|'+scope.major]||0:0);
  return until>t?{retryAfterSeconds:Math.ceil((until-t)/1000),automaticRetryAllowed:true,global:globalUntil>t,scope:globalUntil>t?'global':'user',bucket:bucket||null}:null;
}
export async function cooldownState(storage,input,now=Date.now()){
  const route=validateScope(input.scope);
  if(input.action==='discord.check')return {retry:await cooldownWait(storage,input.scope,now)};
  if(input.action!=='discord.record')throw new OperationError('INVALID_REQUEST');
  await storage.transaction(async tx=>{
    const state=await tx.get(key)||{globalUntil:0,routes:{},buckets:{},routeBuckets:{},lastNow:0};
    const t=Math.max(now,state.lastNow);state.lastNow=t;
    for(const name of ['routes','buckets'])for(const [k,v]of Object.entries(state[name]))if(v<=t)delete state[name][k];
    const bucket=typeof input.bucket==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(input.bucket)?input.bucket:null;
    if(bucket)state.routeBuckets[route]=bucket;
    if(Object.keys(state.routeBuckets).length>64)throw new OperationError('STATE_UNAVAILABLE',503);
    if(input.retry){
      const seconds=input.retry.retryAfterSeconds;
      if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<=0||seconds>Number.MAX_SAFE_INTEGER/1000)throw new OperationError('INVALID_REQUEST');
      const until=Math.min(Number.MAX_SAFE_INTEGER,t+Math.ceil(seconds*1000)+250);
      if(input.retry.global===true||input.retry.scope==='global')state.globalUntil=Math.max(state.globalUntil,until);
      else if(bucket)state.buckets[bucket+'|'+input.scope.major]=Math.max(state.buckets[bucket+'|'+input.scope.major]||0,until);
      else state.routes[route]=Math.max(state.routes[route]||0,until);
    }
    await tx.put(key,state);
  });await storage.sync();return {recorded:true};
}
