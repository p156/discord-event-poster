import {internalProof} from './post-keys.mjs';
import {DiscordTransportError,discordRateInfo} from './discord-client.mjs';
export function scopeFor(url,method,forumId){
  const u=new URL(url);if(u.origin!=='https://discord.com'||u.search||u.hash)throw new DiscordTransportError('CONFIG_INVALID');
  const p=u.pathname;
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
    const scope=scopeFor(url,opts.method||'GET',env.DISCORD_FORUM_CHANNEL_ID);
    const {retry}=await command(env,token,{action:'discord.check',scope});
    if(retry)throw new DiscordTransportError('HTTP_ERROR',429,retry);
    const response=await fetchImpl(url,opts);
    const raw=response.headers.get('X-RateLimit-Bucket');const bucket=raw&&!raw.includes(env.DISCORD_BOT_TOKEN)&&/^[a-zA-Z0-9_-]{1,128}$/.test(raw)?raw:null;
    if(response.status===429||bucket){
      const rate=response.status===429?await discordRateInfo(response.clone(),env.DISCORD_BOT_TOKEN,opts.signal):null;
      await command(env,token,{action:'discord.record',scope,bucket,retry:rate});
    }
    return response;
  };
}
