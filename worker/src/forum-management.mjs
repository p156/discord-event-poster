import {readPostRequest,isSnowflake,PostInputError} from './forum-input.mjs';
import {OperationError} from './post-keys.mjs';
import {managementCall} from './forum-registry.mjs';
import {verifyForumAccess,VIEW,SEND,HISTORY} from './forum-access.mjs';
import {readDiscord,DiscordTransportError} from './discord-client.mjs';
import {createDiscordFetch} from './discord-cooldown.mjs';
import {forumTagMapping} from './forum-tags.mjs';
import {syncHistory} from './forum-history.mjs';
import {createPostHandler} from './post-handler.mjs';
import {createImagePreviewHandler} from './image-preview-handler.mjs';

const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
function fields(value,allowed){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new OperationError('INVALID_REQUEST');
  return value;
}
export async function handleManagement(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(url.search)throw new OperationError('INVALID_REQUEST');
  if(request.method==='OPTIONS'){
    const hs=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
    if(!['GET','POST'].includes(request.headers.get('Access-Control-Request-Method'))||hs.some(h=>!['authorization','content-type','idempotency-key'].includes(h)))throw new OperationError('ORIGIN_REJECTED',403);
    return new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Authorization, Content-Type, Idempotency-Key'}});
  }
  if(!['/api/forums','/api/forums/register','/api/forums/remove','/api/forums/select','/api/discord/guilds','/api/discord/forums'].includes(path)&&!/^\/api\/forums\/[1-9]\d{0,19}\//.test(path))throw new OperationError('ROUTE_NOT_FOUND',404);
  const token=request.headers.get('Authorization')?.match(/^Bearer (oauth2\.[a-f0-9.]{1,160})$/)?.[1];
  if(!token)throw new OperationError('SESSION_REQUIRED',401);
  await managementCall(env,token,{action:'forum.list'});
  const options={fetchImpl:createDiscordFetch(env,token)};
  const body=async allowed=>fields(await readPostRequest(request,{validate:v=>v}),allowed);
  if(path==='/api/forums'&&request.method==='GET')return json(await managementCall(env,token,{action:'forum.list'}));
  if(path==='/api/discord/guilds'&&request.method==='POST'){
    const b=await body(['after','shard']);if(b.after&&!isSnowflake(b.after)||b.shard!==undefined&&(!Number.isSafeInteger(b.shard)||b.shard<0))throw new OperationError('INVALID_REQUEST');
    const data=await readDiscord(env,'users/@me/guilds?'+new URLSearchParams({limit:'200',...(b.after?{after:b.after}:{}),...(b.shard!==undefined?{shard:String(b.shard)}:{})}),options);
    if(!Array.isArray(data)||data.some(g=>!isSnowflake(g?.id)||typeof g.name!=='string'))throw new OperationError('DISCORD_RESPONSE_INVALID',502);
    const after=data.length===200?data.reduce((max,g)=>BigInt(g.id)>BigInt(max)?g.id:max,'0'):null;
    if(after&&b.after&&BigInt(after)<=BigInt(b.after))throw new OperationError('DISCORD_CURSOR_STALLED',502);
    const guilds=data.map(g=>({id:g.id,name:g.name}));
    return json({guilds,after});
  }
  if(path==='/api/discord/forums'&&request.method==='POST'){
    const b=await body(['guildId']);if(!isSnowflake(b.guildId))throw new OperationError('INVALID_REQUEST');
    const member=await readDiscord(env,'guilds/'+b.guildId+'/members/'+env.DISCORD_ALLOWED_USER_ID,options);
    if(member?.user?.id!==env.DISCORD_ALLOWED_USER_ID)throw new OperationError('FORUM_ACCESS_DENIED',403);
    const data=await readDiscord(env,'guilds/'+b.guildId+'/channels',options);
    if(!Array.isArray(data))throw new OperationError('DISCORD_RESPONSE_INVALID',502);
    const forums=[];
    for(const c of data.filter(c=>c.type===15)){
      try{await verifyForumAccess(env,c.id,options);forums.push({id:c.id,guildId:b.guildId,name:c.name});}
      catch(e){if(e.httpStatus!==403&&e.status!==403&&e.status!==404)throw e;}
    }
    return json({forums});
  }
  if(['/api/forums/register','/api/forums/remove','/api/forums/select'].includes(path)&&request.method==='POST'){
    const selecting=path==='/api/forums/select';
    const b=await body(selecting?['forumId','expectedRevision','expectedGeneration']:['forumId']);if(!isSnowflake(b.forumId))throw new OperationError('INVALID_REQUEST');
    const action='forum.'+path.split('/').at(-1);
    let extra={};
    if(action!=='forum.remove'){
      const {channel}=await verifyForumAccess(env,b.forumId,options);
      extra={guildId:channel.guild_id,name:channel.name};
    }
    return json(await managementCall(env,token,{action,forumId:b.forumId,...extra,...(selecting?{expectedRevision:b.expectedRevision,expectedGeneration:b.expectedGeneration}:{})}));
  }
  const match=path.match(/^\/api\/forums\/([1-9]\d{0,19})\/(tags|history\/(?:read|sync|compare)|post-intents|posts(?:\/[a-f0-9-]+)?|image-preview|image-thumbnail)$/);
  if(!match)throw new OperationError('ROUTE_NOT_FOUND',404);
  const [,forumId,resource]=match;
  // Old signed operation receipts remain inspectable after unregistration.
  const inspecting=resource.startsWith('posts/')&&request.method==='GET';
  const target=inspecting?null:(await managementCall(env,token,{action:'forum.resolve',forumId})).forum;
  const scoped={...env,DISCORD_FORUM_CHANNEL_ID:forumId,MANAGED_FORUM:true,TARGET_GENERATION:target?.generation};
  if(resource.startsWith('posts')||resource==='post-intents'||resource.startsWith('image-')){
    if(!resource.startsWith('image-')&&env.FORUM_POSTS_ENABLED!=='true'&&!(inspecting&&env.FORUM_POSTS_ENABLED==='read-only'))throw new OperationError('ROUTE_NOT_FOUND',404);
    if(resource.startsWith('image-'))await verifyForumAccess(env,forumId,options);
    const u=new URL(request.url);u.pathname='/api/forum/'+resource;
    return resource.startsWith('image-')?createImagePreviewHandler()(new Request(u,request),scoped):createPostHandler()(new Request(u,request),scoped);
  }
  if(resource==='tags'&&request.method==='GET'){
    const {channel}=await verifyForumAccess(env,forumId,options);
    return json(forumTagMapping(channel));
  }
  if(!resource.startsWith('history/')||request.method!=='POST')throw new OperationError('METHOD_NOT_ALLOWED',405);
  try{
    const b=await body(resource==='history/compare'?['titles']:resource==='history/read'?['after']:[]);
    const access=await verifyForumAccess(env,forumId,options,VIEW|HISTORY);
    if(resource==='history/sync')return json({forumId,...await syncHistory(scoped,token,forumId,access,options)});
    return json(await managementCall(env,token,{action:resource==='history/read'?'history.read':'history.compare',forumId,...b}));
  }catch(e){
    if(e instanceof PostInputError||e.code==='INVALID_REQUEST')throw e;
    // History is advisory. No writes, post keys, image tickets, or post gates here.
    return json({forumId,items:[],matches:[],unverified:true,sync:{status:'partial',complete:false,more:true,error:e.status===429?'DISCORD_RATE_LIMITED':'HISTORY_UNAVAILABLE',retryAfterSeconds:e.rate?.retryAfterSeconds||0}});
  }
}
export function managementError(error){
  const status=error instanceof OperationError||error instanceof PostInputError?error.httpStatus:error instanceof DiscordTransportError&&error.status===429?429:error instanceof DiscordTransportError&&[403,404].includes(error.status)?403:503;
  const retryAfterSeconds=error.rate?.retryAfterSeconds;
  const response=json({error:{code:error instanceof OperationError||error instanceof PostInputError?error.code:status===429?'DISCORD_RATE_LIMITED':status===403?'FORUM_ACCESS_DENIED':'SERVICE_UNAVAILABLE'},...(retryAfterSeconds?{retryAfterSeconds}:{})},status);
  if(retryAfterSeconds)response.headers.set('Retry-After',String(Math.ceil(retryAfterSeconds)));
  return response;
}
