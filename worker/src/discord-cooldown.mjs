import {internalProof} from './post-keys.mjs';
import {DiscordTransportError,discordRateInfo} from './discord-client.mjs';
export function scopeFor(url,method,forumId){
  const u=new URL(url);if(u.origin!=='https://discord.com'||u.hash)throw new DiscordTransportError('CONFIG_INVALID');
  const p=u.pathname;
  if(method==='GET'){
    const query=[...u.searchParams.keys()];
    let match;
    if(p==='/api/v10/users/@me/guilds'&&query.every(k=>['after','limit','shard'].includes(k))&&query.every(k=>u.searchParams.getAll(k).length===1)&&(!u.searchParams.has('after')||/^[1-9]\d{0,19}$/.test(u.searchParams.get('after')))&&(!u.searchParams.has('limit')||u.searchParams.get('limit')==='200')&&(!u.searchParams.has('shard')||/^\d{1,8}$/.test(u.searchParams.get('shard'))))return {route:'GET user/guilds',major:'none'};
    if((match=p.match(/^\/api\/v10\/guilds\/([1-9]\d{0,19})\/(channels|threads\/active)$/))&&!u.search)return {route:'GET guild/'+(match[2]==='channels'?'channels':'active'),major:'guild:'+match[1]};
    if((match=p.match(/^\/api\/v10\/channels\/([1-9]\d{0,19})\/threads\/archived\/public$/))&&query.every(k=>['before','limit'].includes(k))&&query.every(k=>u.searchParams.getAll(k).length===1)&&(!u.searchParams.has('limit')||u.searchParams.get('limit')==='50')&&(!u.searchParams.has('before')||Number.isFinite(Date.parse(u.searchParams.get('before')))))return {route:'GET channel/archive',major:'channel:'+match[1]};
    if((match=p.match(/^\/api\/v10\/channels\/([1-9]\d{0,19})\/messages\/([1-9]\d{0,19})$/))&&!u.search&&match[1]===match[2])return {route:'GET channel/starter',major:'channel:'+match[1]};
    if((match=p.match(/^\/api\/v10\/channels\/([1-9]\d{0,19})\/permissions\/member\/([1-9]\d{0,19})$/))&&!u.search)return {route:'GET channel/permissions',major:'channel:'+match[1]};
    if((match=p.match(/^\/api\/v10\/channels\/([1-9]\d{0,19})$/))&&!u.search)return {route:'GET channel',major:'channel:'+match[1]};
  }
  if(u.search)throw new DiscordTransportError('CONFIG_INVALID');
  if(p==='/api/v10/channels/'+forumId&&method==='GET')return {route:'GET channel',major:'channel:'+forumId};
  if(p==='/api/v10/channels/'+forumId+'/webhooks'&&method==='GET')return {route:'GET channel/webhooks',major:'channel:'+forumId};
  if(p==='/api/v10/channels/'+forumId+'/threads'&&method==='POST')return {route:'POST channel/threads',major:'channel:'+forumId};
  if(p==='/api/v10/users/@me'&&method==='GET')return {route:'GET users/@me',major:'none'};
  const guild=p.match(/^\/api\/v10\/guilds\/([1-9]\d{0,19})\/(roles|members\/[1-9]\d{0,19})$/);
  if(guild&&method==='GET')return {route:guild[2]==='roles'?'GET guild/roles':'GET guild/member',major:'guild:'+guild[1]};
  throw new DiscordTransportError('CONFIG_INVALID');
}
async function command(env,token,body){
  const packet={...body,token};const proof=await internalProof(packet,env.SESSION_SIGNING_KEY);
  const response=await env.AUTH_STATE.get(env.AUTH_STATE.idFromName('personal-auth-v1')).fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify({...packet,proof})}));
  if(!response.ok)throw new DiscordTransportError('STATE_UNAVAILABLE');return response.json();
}
export function createDiscordFetch(env,token,fetchImpl=globalThis.fetch){
  return async(url,opts={})=>{
    if(opts.signal?.aborted)throw new DiscordTransportError('TIMEOUT');
    const scope=scopeFor(url,opts.method||'GET',env.DISCORD_FORUM_CHANNEL_ID);
    const {retry}=await command(env,token,{action:'discord.check',scope});
    if(retry)throw new DiscordTransportError('HTTP_ERROR',429,retry);
    if(opts.signal?.aborted)throw new DiscordTransportError('TIMEOUT');
    const response=await fetchImpl(url,opts);
    const raw=response.headers.get('X-RateLimit-Bucket');const bucket=raw&&!raw.includes(env.DISCORD_BOT_TOKEN)&&/^[a-zA-Z0-9_-]{1,128}$/.test(raw)?raw:null;
    if(response.status===429||bucket){
      const rate=response.status===429?await discordRateInfo(response.clone(),env.DISCORD_BOT_TOKEN,opts.signal):null;
      await command(env,token,{action:'discord.record',scope,bucket,retry:rate});
    }
    return response;
  };
}
