import {verifyForumAccess} from './forum-access.mjs';
import {fetchAttachment} from './official-image-fetch.mjs';
// INTERNAL ONLY. Not imported by the public Worker entrypoint.
// Step 3 must commit durable sending/quota BEFORE calling sendPreparedForumPost.
import { PostInputError,validatePostPayload,isSnowflake } from './forum-input.mjs';
import { selectedForumTags,botCanManageThreads } from './forum-tags.mjs';
import { DiscordTransportError,fixedDiscordConfig,readFixedForum,sendFixedForum,forumUpload,readBotSelf,readForumRoles,readForumMember } from './discord-client.mjs';
const preparedContexts=new WeakMap();
function failure(error,stage,writeStarted){
  const result={outcome:writeStarted?'unknown':'not_sent',stage,writeStarted,code:writeStarted?'OUTCOME_UNKNOWN':'SERVICE_UNAVAILABLE',failureCode:'NETWORK',httpStatus:writeStarted?502:503,upstreamStatus:null,safeToRetry:!writeStarted,retry:null,fields:[],result:null};
  if(error instanceof PostInputError)return {...result,outcome:'not_sent',code:error.code,failureCode:error.code,httpStatus:error.httpStatus,safeToRetry:false,fields:error.fields};
  if(error instanceof DiscordTransportError){result.failureCode=error.kind;result.upstreamStatus=error.status;
    if(error.kind==='CONFIG_INVALID')return {...result,outcome:'not_sent',writeStarted:false,code:'SERVICE_UNAVAILABLE',safeToRetry:false};
    if(error.status===429)return {...result,outcome:writeStarted?'rejected':'not_sent',code:'DISCORD_RATE_LIMITED',failureCode:'RATE_LIMITED',httpStatus:429,safeToRetry:true,retry:error.rate};
    const codes={400:'DISCORD_REQUEST_REJECTED',401:'DISCORD_CREDENTIAL_REJECTED',403:'DISCORD_PERMISSION_DENIED',404:'DISCORD_TARGET_UNAVAILABLE'};
    if(error.kind==='HTTP_ERROR'&&codes[error.status])return {...result,outcome:writeStarted?'rejected':'not_sent',code:codes[error.status],httpStatus:502,safeToRetry:false};
  }
  return result;
}
async function data(task){const r=await task;if(r.status===429)throw new DiscordTransportError('HTTP_ERROR',429,r.rate);return r.body;}
export async function prepareForumPost(env,rawPayload,options={}){
  let stage='input';
  try{
    const payload=validatePostPayload(rawPayload),config=fixedDiscordConfig(env);stage='preflight';
    let channel;
    if(env.MANAGED_FORUM||env.CHECK_FORUM_ACCESS){
      try{channel=(await verifyForumAccess(env,config.DISCORD_FORUM_CHANNEL_ID,options)).channel;}
      catch(error){if(error.httpStatus===403)throw new DiscordTransportError('HTTP_ERROR',403);throw error;}
    }else channel=await data(readFixedForum(config,options));const selected=selectedForumTags(channel,config.DISCORD_FORUM_CHANNEL_ID,payload.tagIds);
    if(selected.some(t=>t.moderated)){
      const self=await data(readBotSelf(config,options));if(!isSnowflake(self?.id)||self.bot!==true)throw new PostInputError('TAG_PERMISSION_UNVERIFIED',422,['tagIds']);
      const roles=await data(readForumRoles(config,channel.guild_id,options));const member=await data(readForumMember(config,channel.guild_id,self.id,options));
      if(!botCanManageThreads(channel,self,member,roles))throw new PostInputError('TAG_PERMISSION_UNVERIFIED',422,['tagIds']);
    }
    const context=Object.freeze(Object.create(null));preparedContexts.set(context,{config,payload,guildId:channel.guild_id,createdAt:Date.now(),options:{fetchImpl:options.fetchImpl,timeoutMs:options.timeoutMs},imageFetchImpl:options.imageFetchImpl});
    return {outcome:'prepared',context,target:Object.freeze({forumId:config.DISCORD_FORUM_CHANNEL_ID,guildId:channel.guild_id})};
  }catch(error){return failure(error,stage,false);}
}
export async function sendPreparedForumPost(context){
  const prepared=preparedContexts.get(context);preparedContexts.delete(context);if(!prepared||Date.now()-prepared.createdAt>15000||Date.now()<prepared.createdAt)return {outcome:'not_sent',stage:'input',writeStarted:false,code:'ADAPTER_CONTEXT_INVALID',failureCode:'ADAPTER_CONTEXT_INVALID',httpStatus:409,upstreamStatus:null,safeToRetry:false,retry:null,fields:[],result:null};
  preparedContexts.delete(context); // one-use in-memory handoff, NOT durable idempotency
  const {config,payload,guildId,options,imageFetchImpl}=prepared;
  const body={name:payload.threadName,message:{content:payload.content,allowed_mentions:{parse:[],replied_user:false}},applied_tags:payload.tagIds};
  try{
    // This is reached only after durable sending/quota in the public handler.
    // Revalidate the frozen image URL with the existing host/MIME/magic/size
    // policy. Never forward Discord authorization to the image host.
    let upload;
    if(payload.apiVersion===2&&payload.imageUrl){
      try{upload=await forumUpload(body,await fetchAttachment(payload.officialUrl,payload.imageUrl,{fetchImpl:imageFetchImpl}));}
      catch{/* Optional image failed before Discord write: continue with text. */}
    }
    // No embeds or flags, regardless of image availability: keep URL unfurling.
    let response;
    try{response=await sendFixedForum(config,body,{...options,upload});}
    catch(error){
      // A definite invalid/oversized request did not create a thread. Only then
      // may this SAME durable attempt try text once. Never retry an ambiguous
      // response, network failure, timeout, 5xx, 429, or invalid success receipt.
      if(!upload||!(error instanceof DiscordTransportError)||error.kind!=='HTTP_ERROR'||![400,413].includes(error.status))throw error;
      response=await sendFixedForum(config,body,options);
    }
    if(response.status===429)return failure(new DiscordTransportError('HTTP_ERROR',429,response.rate),'write',true);
    const thread=response.body;
    if(!thread||thread.type!==11||thread.parent_id!==config.DISCORD_FORUM_CHANNEL_ID||thread.guild_id!==guildId||!isSnowflake(thread.id)||!isSnowflake(thread.message?.id)||thread.message.channel_id!==thread.id)throw new DiscordTransportError('RECEIPT_INVALID',response.status);
    const result={guildId,forumId:config.DISCORD_FORUM_CHANNEL_ID,threadId:thread.id,messageId:thread.message.id,threadUrl:'https://discord.com/channels/'+guildId+'/'+thread.id,url:'https://discord.com/channels/'+guildId+'/'+thread.id+'/'+thread.message.id};
    return {outcome:'succeeded',stage:'write',writeStarted:true,code:null,failureCode:null,httpStatus:201,upstreamStatus:response.status,safeToRetry:false,retry:null,fields:[],result};
  }catch(error){return failure(error,'write',true);}
}
