import {authenticatedSession,migrateAuthentication,SESSION_KEY,sessionConfigured} from './auth-session.mjs';
import {oauthState,cleanupOAuth} from './oauth-state.mjs';
import {handleOAuth,oauthConfigured} from './oauth-handler.mjs';
import { hasAllowedHost } from './request-boundary.mjs';
import { fetchLegacyForum } from './discord-client.mjs';
import { forumTagMapping } from './forum-tags.mjs';
import { postState,cleanupPosts } from './post-state.mjs';
import { verifyInternal,OperationError,UUID } from './post-keys.mjs';
import {createPostHandler} from './post-handler.mjs';
import {cooldownState} from './discord-cooldown-state.mjs';
import {createDiscordFetch} from './discord-cooldown.mjs';
import {discordRateInfo,DiscordTransportError} from './discord-client.mjs';

const json = (value,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
export class AuthState {
  constructor(state,env) { this.storage=state.storage; this.env=env; this.queue=Promise.resolve(); }
  // Serialize durable authentication/post operations; OAuth network calls run outside this queue.
  fetch(request) { const operation=this.queue.then(()=>this.handle(request)); this.queue=operation.catch(()=>{}); return operation; }
  alarm() { const operation=this.queue.then(async()=>{const now=Date.now();await migrateAuthentication(this.storage);await cleanupOAuth(this.storage,now);await cleanupPosts(this.storage,now);});this.queue=operation.catch(()=>{});return operation; }
  async handle(request) {
    const packet=await request.json();const {action,token}=packet; const now=Date.now();
    if(!sessionConfigured(this.env)||!oauthConfigured(this.env))return json({error:{code:'AUTH_NOT_CONFIGURED'}},503);
    await migrateAuthentication(this.storage);
    if(typeof action==='string'&&action.startsWith('oauth.')){
      const {proof,...body}=packet;
      if(!oauthConfigured(this.env)||request.url!=='https://internal/auth'||request.method!=='POST'||!await verifyInternal(body,proof,this.env.SESSION_SIGNING_KEY))return json({error:{code:'INTERNAL_ACCESS_REJECTED'}},403);
      try{return json(await oauthState(this.storage,this.env,body,now));}
      catch(error){return json({error:{code:error instanceof OperationError?error.code:'STATE_UNAVAILABLE'}},error instanceof OperationError?error.httpStatus:503);}
    }
    if(!['check','logout'].includes(action)&&!(typeof action==='string'&&(action.startsWith('post.')||action.startsWith('discord.'))))return json({error:{code:'AUTH_METHOD_REMOVED'}},404);
    const verified=await authenticatedSession(this.storage,this.env,token);
    if(!verified)return json({error:'ログインし直してください。'},401);
    if(typeof action==='string'&&(action.startsWith('post.')||action.startsWith('discord.'))){
      const {proof,...body}=packet;
      if(request.url!=='https://internal/auth'||request.method!=='POST'||!await verifyInternal(body,proof,this.env.SESSION_SIGNING_KEY))return json({error:{code:'INTERNAL_ACCESS_REJECTED'}},403);
      try{return json(action.startsWith('post.')?await postState(this.storage,this.env,body,now):await cooldownState(this.storage,body,now));}
      catch(error){return json({error:{code:error instanceof OperationError?error.code:'STATE_UNAVAILABLE'}},error instanceof OperationError?error.httpStatus:503);}
    }
    if(action==='logout'){const sessions=await this.storage.get(SESSION_KEY)||[];await this.storage.put(SESSION_KEY,sessions.filter(s=>s.id!==verified.id));await this.storage.sync();}
    return json({authenticated:true});
  }
}
async function smallJson(request) {
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new Error();
  const reader=request.body?.getReader(); if(!reader)throw new Error(); let length=0,parts=[];
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>4096){await reader.cancel();throw new Error();}parts.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
function configured(env) {
  return oauthConfigured(env)&&/^\d{1,20}$/.test(env.DISCORD_FORUM_CHANNEL_ID||'')&&env.DISCORD_BOT_TOKEN;
}
function diagnostic(stage,error,status) {
  const name=typeof error?.name==='string'&&/^[A-Za-z][A-Za-z0-9_$.-]{0,63}$/.test(error.name)?error.name:'Error';
  const entry={event:'request_failed',stage,errorName:name};
  if(Number.isInteger(status)&&status>=100&&status<=599)entry.status=status;
  console.error(JSON.stringify(entry));
}
async function auth(env,payload) { const stub=env.AUTH_STATE.get(env.AUTH_STATE.idFromName('personal-auth-v1'));return stub.fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify(payload)})); }
export default {
  async fetch(request,env) {
    if(!hasAllowedHost(request))return json({error:'アクセスできません。'},403);
    const oauthPath=new URL(request.url).pathname;
    if(['/api/oauth/start','/api/oauth/callback','/api/oauth/complete'].includes(oauthPath)&&request.method!=='OPTIONS')return handleOAuth(request,env);
    const origin=request.headers.get('Origin');
    if(!origin||origin!==env.ALLOWED_ORIGIN)return json({error:'アクセスできません。'},403);
    const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Expose-Headers':'Retry-After,Location','Vary':'Origin','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    let response,stage='request';
    try {
      const url=new URL(request.url),path=url.pathname;
      if(path==='/api/forum/posts'||path==='/api/forum/post-intents'||path.startsWith('/api/forum/posts/')){
        const readOnly=env.FORUM_POSTS_ENABLED==='read-only'&&path.startsWith('/api/forum/posts/')&&UUID.test(path.slice('/api/forum/posts/'.length))&&(request.method==='GET'||request.method==='OPTIONS'&&request.headers.get('Access-Control-Request-Method')==='GET');
        if(env.FORUM_POSTS_ENABLED!=='true'&&!readOnly)response=json({error:'APIが見つかりません。'},404);
        else return createPostHandler()(request,env);
      }
      else if(url.search)response=json({error:'パラメーターは利用できません。'},400);
      else if(request.method==='OPTIONS') {
        const method=request.headers.get('Access-Control-Request-Method');
        const requested=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
        if(!['GET','POST'].includes(method)||requested.some(h=>!['authorization','content-type'].includes(h)))response=json({error:'アクセスできません。'},403);
        else response=new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'}});
      } else if(path==='/api/login')response=json({error:{code:'AUTH_METHOD_REMOVED'}},404);
      else if(!configured(env))response=json({error:'認証サービスの設定が完了していません。'},503);
      else if((path==='/api/logout'&&request.method==='POST')||(path==='/api/session'&&request.method==='GET')||(path==='/api/forum/tags'&&request.method==='GET')||(path==='/api/forum/webhook-check'&&request.method==='POST')) {
        const token=request.headers.get('Authorization')?.match(/^Bearer (oauth2\.[a-f0-9.]{1,160})$/)?.[1]||'';
        stage='auth_check';
        response=await auth(env,{action:path==='/api/logout'?'logout':'check',token});
        if(response.ok&&path==='/api/session')response=json({authenticated:true,capabilities:{forumPosts:env.FORUM_POSTS_ENABLED==='true',forumPostStatus:['true','read-only'].includes(env.FORUM_POSTS_ENABLED),apiVersion:1,operationTicket:'v1'}});
        if(response.ok&&path==='/api/forum/tags') {
          stage='discord_fetch';
          const discordResponse=await fetchLegacyForum(env,false,createDiscordFetch(env,token));
          stage='discord_response';
          if(discordResponse.status>=300&&discordResponse.status<400){diagnostic(stage,null,discordResponse.status);response=json({error:'Discordフォーラムを取得できませんでした。'},502);}
          else if(discordResponse.status===429){diagnostic(stage,null,429);const rate=await discordRateInfo(discordResponse,env.DISCORD_BOT_TOKEN);response=json({error:{code:'DISCORD_RATE_LIMITED'},retryAfterSeconds:rate.retryAfterSeconds},429);response.headers.set('Retry-After',String(Math.ceil(rate.retryAfterSeconds)));}
          else if(!discordResponse.ok){diagnostic(stage,null,discordResponse.status);response=json({error:'Discordフォーラムを取得できませんでした。'},502);}
          else {
            stage='discord_json_parse';
            const channel=await discordResponse.json();
            stage='discord_response';
            if(!channel||channel.id!==env.DISCORD_FORUM_CHANNEL_ID||channel.type!==15||!Array.isArray(channel.available_tags)){diagnostic(stage,{name:'InvalidForumResponse'});response=json({error:'Discordフォーラムを取得できませんでした。'},502);}
            else {
              stage='discord_tag_mapping';
              response=json(forumTagMapping(channel));
            }
          }
        } else if(response.ok&&path==='/api/forum/webhook-check') {
          const body=await smallJson(request);
          if(typeof body.webhookId!=='string'||!/^\d{1,20}$/.test(body.webhookId))response=json({error:'Webhook IDを確認してください。'},400);
          else {
            // Only list webhooks belonging to the fixed forum; never proxy arbitrary API routes.
            stage='discord_fetch';
            const discordResponse=await fetchLegacyForum(env,true,createDiscordFetch(env,token));
            stage='discord_response';
            if(discordResponse.status>=300&&discordResponse.status<400){diagnostic(stage,null,discordResponse.status);response=json({error:'Webhookの所属確認に失敗しました。'},502);}
            else if(discordResponse.status===429){diagnostic(stage,null,429);const rate=await discordRateInfo(discordResponse,env.DISCORD_BOT_TOKEN);response=json({error:{code:'DISCORD_RATE_LIMITED'},retryAfterSeconds:rate.retryAfterSeconds},429);response.headers.set('Retry-After',String(Math.ceil(rate.retryAfterSeconds)));}
            else if(!discordResponse.ok){diagnostic(stage,null,discordResponse.status);response=json({error:'Webhookの所属確認に失敗しました。'},502);}
            else {
              stage='discord_json_parse';
              const hooks=await discordResponse.json();
              response=!Array.isArray(hooks)?json({error:'Webhookの所属確認に失敗しました。'},502):hooks.some(h=>h.id===body.webhookId&&h.type===1&&h.channel_id===env.DISCORD_FORUM_CHANNEL_ID)?json({forumId:env.DISCORD_FORUM_CHANNEL_ID,webhookId:body.webhookId}):json({error:'対象フォーラムのWebhookではありません。'},409);
            }
          }
        }
      } else response=json({error:'APIが見つかりません。'},404);
    } catch(error) { if(error instanceof DiscordTransportError&&error.status===429){response=json({error:{code:'DISCORD_RATE_LIMITED'},retryAfterSeconds:error.rate.retryAfterSeconds},429);response.headers.set('Retry-After',String(Math.ceil(error.rate.retryAfterSeconds)));}else{diagnostic(stage,error);response=json({error:'処理を完了できませんでした。'},503);} }
    const result=new Response(response.body,response);for(const [key,value]of Object.entries(headers))result.headers.set(key,value);return result;
  }
};
