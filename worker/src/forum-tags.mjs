import { isSnowflake,PostInputError } from './forum-input.mjs';
export const EVENT_TAG_NAMES=Object.freeze(['周遊型','ホール型','ルーム型','オンライン','持ち帰り','イマーシブ','謎解き','ホラー']);
// Preserve the existing Phase 2 response shape and matching rules.
export function forumTagMapping(channel) {
  const tags=channel.available_tags.map(t=>({id:t.id,name:t.name})),mapping={},missing=[],duplicates=[];
  for(const name of EVENT_TAG_NAMES){const matches=tags.filter(t=>t.name===name);if(matches.length===0)missing.push(name);else if(matches.length>1)duplicates.push(name);else if(/^\d{1,20}$/.test(matches[0].id))mapping[name]=matches[0].id;else missing.push(name);}
  return {forumId:channel.id,tags,mapping,missing,duplicates,unknown:tags.filter(t=>!EVENT_TAG_NAMES.includes(t.name)).map(t=>t.name)};
}
export function selectedForumTags(channel,forumId,tagIds) {
  if(channel?.id!==forumId||channel.type!==15||!isSnowflake(channel.guild_id)||!Array.isArray(channel.available_tags)||!channel.available_tags.every(t=>t&&isSnowflake(t.id)&&typeof t.name==='string')||!Number.isSafeInteger(channel.flags??0)|| (channel.flags??0)<0)throw new PostInputError('FORUM_RESPONSE_INVALID',503);
  if((BigInt(channel.flags??0)&16n)&&tagIds.length===0)throw new PostInputError('TAG_REQUIRED',422,['tagIds']);
  const mapped=forumTagMapping(channel),selected=[];
  for(const id of tagIds){const matches=channel.available_tags.filter(t=>t.id===id);if(matches.length!==1||!EVENT_TAG_NAMES.includes(matches[0].name)||mapped.mapping[matches[0].name]!==id)throw new PostInputError('TAG_INVALID',422,['tagIds']);if(typeof matches[0].moderated!=='boolean')throw new PostInputError('TAG_PERMISSION_UNVERIFIED',422,['tagIds']);selected.push(matches[0]);}
  return selected;
}
function bits(value){if(typeof value!=='string'||!/^\d{1,20}$/.test(value)||BigInt(value)>18446744073709551615n)throw new PostInputError('TAG_PERMISSION_UNVERIFIED',422,['tagIds']);return BigInt(value);}
export function botCanManageThreads(channel,self,member,roles) {
  const fail=()=>{throw new PostInputError('TAG_PERMISSION_UNVERIFIED',422,['tagIds']);};
  if(!self||self.bot!==true||!isSnowflake(self.id)||member?.user?.id!==self.id||!Array.isArray(member.roles)||member.roles.some(id=>!isSnowflake(id))||!Array.isArray(roles))fail();
  const map=new Map();for(const role of roles){if(!isSnowflake(role?.id)||map.has(role.id))fail();map.set(role.id,bits(role.permissions));}
  if(!map.has(channel.guild_id)||member.roles.some(id=>!map.has(id)))fail();
  let permissions=map.get(channel.guild_id);for(const role of member.roles)permissions|=map.get(role);
  if(permissions&8n)return true; // ADMINISTRATOR bypasses channel overwrites/timeouts.
  if(member.communication_disabled_until!=null){const expiry=Date.parse(member.communication_disabled_until);if(!Number.isFinite(expiry))fail();if(expiry>Date.now())return false;}
  if(!Array.isArray(channel.permission_overwrites))fail();const overwrites=new Map();
  for(const o of channel.permission_overwrites){if(!isSnowflake(o?.id)||![0,1].includes(o.type)||overwrites.has(o.type+':'+o.id))fail();overwrites.set(o.type+':'+o.id,{allow:bits(o.allow),deny:bits(o.deny)});}
  const apply=o=>{if(o)permissions=(permissions&~o.deny)|o.allow;};apply(overwrites.get('0:'+channel.guild_id));
  let allow=0n,deny=0n;for(const role of member.roles){if(role===channel.guild_id)continue;const o=overwrites.get('0:'+role);if(o){allow|=o.allow;deny|=o.deny;}}permissions=(permissions&~deny)|allow;apply(overwrites.get('1:'+self.id));
  return Boolean((permissions&1024n)&&(permissions&(1n<<34n)));
}
