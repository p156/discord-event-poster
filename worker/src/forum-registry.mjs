import {OperationError,internalProof} from './post-keys.mjs';
import {isSnowflake} from './forum-input.mjs';

// Additive KV schema on the existing SQLite-backed DO; never replace auth/post keys.
const key='forums:registry:v1';
export async function registry(storage,env){
  let value=await storage.get(key);
  if(!value){
    value={v:1,revision:1,selected:env.DISCORD_FORUM_CHANNEL_ID||'',forums:[]};
    if(isSnowflake(value.selected))value.forums.push({id:value.selected,guildId:null,name:'既存のフォーラム',generation:1,active:true});
    await storage.put(key,value);await storage.sync();
  }
  return value;
}
export async function registeredTarget(storage,env,id){
  const r=await storage.get(key);
  if(!r&&id===env.DISCORD_FORUM_CHANNEL_ID)return {id,generation:0};
  const item=r?.forums.find(f=>f.id===id&&f.active);
  if(!item)throw new OperationError('TARGET_CHANGED',409);
  return item;
}
export async function forumState(storage,env,input){
  const r=await registry(storage,env);
  if(input.action==='forum.list')return {forums:r.forums.filter(f=>f.active),selected:r.selected,revision:r.revision,legacyForumId:env.DISCORD_FORUM_CHANNEL_ID};
  if(input.action==='forum.resolve')return {forum:await registeredTarget(storage,env,input.forumId)};
  if(!isSnowflake(input.forumId))throw new OperationError('INVALID_REQUEST');
  if(input.action==='forum.register'){
    if(!isSnowflake(input.guildId)||typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new OperationError('INVALID_REQUEST');
    let f=r.forums.find(f=>f.id===input.forumId);
    if(f){f.generation++;Object.assign(f,{active:true,guildId:input.guildId,name:input.name});}
    else r.forums.push({id:input.forumId,guildId:input.guildId,name:input.name,generation:1,active:true});
  }else if(input.action==='forum.remove'){
    const f=r.forums.find(f=>f.id===input.forumId);if(f){f.active=false;f.generation++;}
    if(r.selected===input.forumId)r.selected='';
  }else if(input.action==='forum.select'){
    if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1)throw new OperationError('INVALID_REQUEST');
    const target=await registeredTarget(storage,env,input.forumId);
    if(target.generation!==input.expectedGeneration)throw new OperationError('TARGET_CHANGED',409);
    if(r.revision!==input.expectedRevision)throw new OperationError('SELECTION_CONFLICT',409);
    r.selected=input.forumId;
  }else throw new OperationError('INVALID_REQUEST');
  r.revision++;await storage.put(key,r);await storage.sync();
  return {forums:r.forums.filter(f=>f.active),selected:r.selected,revision:r.revision,legacyForumId:env.DISCORD_FORUM_CHANNEL_ID};
}
export async function managementCall(env,token,body){
  const packet={...body,token},proof=await internalProof(packet,env.SESSION_SIGNING_KEY);
  const response=await env.AUTH_STATE.get(env.AUTH_STATE.idFromName('personal-auth-v1')).fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify({...packet,proof})}));
  const result=await response.json();
  if(!response.ok)throw new OperationError(response.status===401?'SESSION_EXPIRED':result.error?.code||'STATE_UNAVAILABLE',response.status);
  return result;
}
