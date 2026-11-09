import {OperationError} from './post-keys.mjs';
import {isSnowflake} from './forum-input.mjs';
import {readDiscord} from './discord-client.mjs';
export const VIEW=1024n,SEND=2048n,HISTORY=65536n;
export async function botIdentity(env,options){
  const self=await readDiscord(env,'users/@me',options);
  if(!isSnowflake(self?.id)||self.bot!==true)throw new OperationError('DISCORD_RESPONSE_INVALID',502);
  return self;
}
function permissions(value){
  if(typeof value!=='string'||!/^\d{1,40}$/.test(value))throw new OperationError('PERMISSION_UNVERIFIED',503);
  return BigInt(value);
}
export async function verifyForumAccess(env,forumId,options={},required=VIEW|SEND){
  if(!isSnowflake(forumId))throw new OperationError('INVALID_REQUEST');
  const channel=await readDiscord(env,'channels/'+forumId,options);
  if(channel?.id!==forumId||channel.type!==15||!isSnowflake(channel.guild_id)||!Array.isArray(channel.available_tags))throw new OperationError('FORUM_INVALID',422);
  const self=await botIdentity(env,options);
  for(const id of [env.DISCORD_ALLOWED_USER_ID,self.id]){
    if(!isSnowflake(id))throw new OperationError('PERMISSION_UNVERIFIED',503);
    let member;try{member=await readDiscord(env,'guilds/'+channel.guild_id+'/members/'+id,options);}catch(e){if([403,404].includes(e.status))throw new OperationError('FORUM_ACCESS_DENIED',403);throw e;}
    if(member?.user?.id!==id||member.pending===true)throw new OperationError('FORUM_ACCESS_DENIED',403);
    const result=await readDiscord(env,'channels/'+forumId+'/permissions/member/'+id,options);
    const bits=permissions(result?.permissions),admin=Boolean(bits&8n);
    if(!admin&&(bits&required)!==required)throw new OperationError('FORUM_ACCESS_DENIED',403);
    if(!admin&&(required&SEND)&&member.communication_disabled_until!=null){
      const expiry=Date.parse(member.communication_disabled_until);
      if(!Number.isFinite(expiry)||expiry>Date.now())throw new OperationError('FORUM_ACCESS_DENIED',403);
    }
  }
  return {channel,self};
}
