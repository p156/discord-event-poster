import { isSnowflake } from './forum-input.mjs';
const BASE='https://discord.com/api/v10/';
export class DiscordTransportError extends Error {
  constructor(kind,status=null,rate=null){super(kind);this.name='DiscordTransportError';this.kind=kind;this.status=status;this.rate=rate;}
}
export function fixedDiscordConfig(env){
  if(!isSnowflake(env?.DISCORD_FORUM_CHANNEL_ID)||typeof env.DISCORD_BOT_TOKEN!=='string'||!env.DISCORD_BOT_TOKEN.length||env.DISCORD_BOT_TOKEN.length>4096||/[\x00-\x20\x7f]/.test(env.DISCORD_BOT_TOKEN))throw new DiscordTransportError('CONFIG_INVALID');
  return Object.freeze({DISCORD_FORUM_CHANNEL_ID:env.DISCORD_FORUM_CHANNEL_ID,DISCORD_BOT_TOKEN:env.DISCORD_BOT_TOKEN});
}
const headers=env=>({Authorization:'Bot '+env.DISCORD_BOT_TOKEN});
// The old read-only API uses the same fixed targets/manual policy without changing
// its error stages, Response interface or JSON parsing behavior.
export function fetchLegacyForum(env,webhooks=false){
  const config=fixedDiscordConfig(env);
  return fetch(BASE+'channels/'+config.DISCORD_FORUM_CHANNEL_ID+(webhooks?'/webhooks':''),{headers:headers(config),redirect:'manual',signal:AbortSignal.timeout(10000)});
}
function rateInfo(response,body,validBody,secret){
  const waits=[];for(const value of [response.headers.get('Retry-After'),response.headers.get('X-RateLimit-Reset-After')])if(typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)&&Number.isFinite(Number(value))&&Number(value)>0&&Number(value)<=Number.MAX_SAFE_INTEGER/1000)waits.push(Number(value));
  if(typeof body?.retry_after==='number'&&Number.isFinite(body.retry_after)&&body.retry_after>0&&body.retry_after<=Number.MAX_SAFE_INTEGER/1000)waits.push(body.retry_after);
  const seconds=waits.length?Math.max(...waits):60;
  const scope=response.headers.get('X-RateLimit-Scope');
  const rawBucket=response.headers.get('X-RateLimit-Bucket');
  return {retryAfterSeconds:seconds,automaticRetryAllowed:Boolean(validBody&&waits.length),global:body?.global===true||response.headers.get('X-RateLimit-Global')==='true',scope:['user','shared','global'].includes(scope)?scope:null,bucket:rawBucket&&!rawBucket.includes(secret)&&/^[a-zA-Z0-9_-]{1,128}$/.test(rawBucket)?rawBucket:null};
}
async function readBytes(response,signal){
  const reader=response.body?.getReader();if(!reader)throw new DiscordTransportError('JSON_INVALID',response.status);
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){cancel();throw new DiscordTransportError('RESPONSE_TOO_LARGE',response.status);}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new DiscordTransportError('JSON_INVALID',response.status);}}
  finally{signal.removeEventListener('abort',cancel);try{reader.releaseLock();}catch{}}
}
async function requestJson(env,path,{method='GET',body,fetchImpl=globalThis.fetch,timeoutMs=10000}={}){
  if(typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new DiscordTransportError('CONFIG_INVALID');
  const config=fixedDiscordConfig(env),controller=new AbortController();let timer,response;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DiscordTransportError('TIMEOUT',response?.status??null,response?.status===429?rateInfo(response,null,false,config.DISCORD_BOT_TOKEN):null));},timeoutMs);});
  const task=(async()=>{
    response=await fetchImpl(BASE+path,{method,headers:{...headers(config),...(body?{'Content-Type':'application/json'}:{})},redirect:'manual',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal,...(body?{body:JSON.stringify(body)}:{})});
    const status=response.status;
    if(status>=300&&status<400){void response.body?.cancel().catch(()=>{});throw new DiscordTransportError('REDIRECT',status);}
    if(status===429){let value=null,valid=false;try{value=await readBytes(response,controller.signal);valid=Boolean(value&&typeof value==='object'&&!Array.isArray(value));}catch{}return {status,body:null,rate:rateInfo(response,value,valid,config.DISCORD_BOT_TOKEN)};}
    if(!response.ok){void response.body?.cancel().catch(()=>{});throw new DiscordTransportError('HTTP_ERROR',status);}
    return {status,body:await readBytes(response,controller.signal),rate:null};
  })();
  try{return await Promise.race([task,timeout]);}
  catch(error){if(response?.status===429)return {status:429,body:null,rate:rateInfo(response,null,false,config.DISCORD_BOT_TOKEN)};if(error instanceof DiscordTransportError)throw error;throw new DiscordTransportError(controller.signal.aborted?'TIMEOUT':'NETWORK',response?.status??null);}
  finally{clearTimeout(timer);controller.abort();}
}
const readOptions=options=>({fetchImpl:options?.fetchImpl,timeoutMs:options?.timeoutMs});
export function readFixedForum(env,options){const config=fixedDiscordConfig(env);return requestJson(config,'channels/'+config.DISCORD_FORUM_CHANNEL_ID,readOptions(options));}
export function sendFixedForum(env,body,options){const config=fixedDiscordConfig(env);return requestJson(config,'channels/'+config.DISCORD_FORUM_CHANNEL_ID+'/threads',{...options,method:'POST',body});}
export function readBotSelf(env,options){return requestJson(env,'users/@me',readOptions(options));}
export function readForumRoles(env,guildId,options){if(!isSnowflake(guildId))throw new DiscordTransportError('CONFIG_INVALID');return requestJson(env,'guilds/'+guildId+'/roles',readOptions(options));}
export function readForumMember(env,guildId,botId,options){if(!isSnowflake(guildId)||!isSnowflake(botId))throw new DiscordTransportError('CONFIG_INVALID');return requestJson(env,'guilds/'+guildId+'/members/'+botId,readOptions(options));}
