import {hasAllowedHost} from './request-boundary.mjs';
import {isSnowflake} from './forum-input.mjs';
import {internalProof,OperationError} from './post-keys.mjs';
import {sessionConfigured,randomHex,digest} from './auth-session.mjs';
const HEX=/^[a-f0-9]{64}$/;
const isHex=value=>typeof value==='string'&&HEX.test(value);
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const cookieName=state=>'__Host-dep-oauth-'+state;
const cookie=(state,value,age)=>cookieName(state)+'='+value+'; Max-Age='+age+'; Path=/; Secure; HttpOnly; SameSite=Lax';
export function oauthConfigured(env){
  try{return !!env.AUTH_STATE&&sessionConfigured(env)&&isSnowflake(env.DISCORD_OAUTH_CLIENT_ID)&&typeof env.DISCORD_OAUTH_CLIENT_SECRET==='string'&&env.DISCORD_OAUTH_CLIENT_SECRET.length>=16&&typeof env.SESSION_SIGNING_KEY==='string'&&env.SESSION_SIGNING_KEY.length>=64&&new URL(env.ALLOWED_ORIGIN).origin===env.ALLOWED_ORIGIN&&env.ALLOWED_ORIGIN.startsWith('https://')&&hasAllowedHost(new Request(env.DISCORD_OAUTH_REDIRECT_URI))&&new URL(env.DISCORD_OAUTH_REDIRECT_URI).pathname==='/api/oauth/callback'&&!new URL(env.DISCORD_OAUTH_REDIRECT_URI).search&&!new URL(env.DISCORD_OAUTH_REDIRECT_URI).hash;}catch{return false;}
}
async function bodyText(request,max=4096){
  const reader=request.body?.getReader();if(!reader)throw new OperationError('OAUTH_INPUT_INVALID',400);
  let length=0,parts=[],timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new OperationError('OAUTH_INPUT_TIMEOUT',408)),5000);});
  try{while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;length+=value.length;if(length>max)throw new OperationError('OAUTH_INPUT_INVALID',400);parts.push(value);}}finally{clearTimeout(timer);reader.cancel().catch(()=>{});}
  const data=new Uint8Array(length);let offset=0;for(const p of parts){data.set(p,offset);offset+=p.length;}
  return new TextDecoder('utf-8',{fatal:true}).decode(data);
}
async function call(env,body){
  const proof=await internalProof(body,env.SESSION_SIGNING_KEY);
  const r=await env.AUTH_STATE.get(env.AUTH_STATE.idFromName('personal-auth-v1')).fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify({...body,proof})}));
  if(!r.ok)throw new OperationError('OAUTH_REJECTED',r.status);return r.json();
}
async function discordJson(url,options){
  const controller=new AbortController();let timer;
  try{return await Promise.race([
    (async()=>{const r=await fetch(url,{...options,redirect:'manual',signal:controller.signal});if(!r.ok||!r.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw new Error('OAUTH_UPSTREAM_FAILED');return JSON.parse(await bodyText(r,16384));})(),
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('OAUTH_TIMEOUT'));},5000);})
  ]);}catch{throw new Error('OAUTH_UPSTREAM_FAILED');}finally{clearTimeout(timer);controller.abort();}
}
async function identify(env,code){
  const data=await discordJson('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:env.DISCORD_OAUTH_REDIRECT_URI,client_id:env.DISCORD_OAUTH_CLIENT_ID,client_secret:env.DISCORD_OAUTH_CLIENT_SECRET}).toString()});
  if(data.token_type!=='Bearer'||typeof data.access_token!=='string'||!data.access_token.length||data.access_token.length>4096||/[\s\x00-\x1f\x7f]/.test(data.access_token)||typeof data.scope!=='string'||data.scope.trim()!=='identify'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw new Error('OAUTH_TOKEN_INVALID');
  const user=await discordJson('https://discord.com/api/v10/users/@me',{headers:{Authorization:'Bearer '+data.access_token}});
  if(!isSnowflake(user.id)||user.id!==env.DISCORD_ALLOWED_USER_ID)throw new OperationError('OAUTH_REJECTED',403);
  return user.id;
}
function callbackPage(env,packet,status=200,setCookie){
  const nonce=randomHex();
  const script='history.replaceState(null,"","/api/oauth/callback");if(window.opener){window.opener.postMessage('+JSON.stringify({type:'discord-event-poster.oauth2',...packet}).replace(/</g,'\\u003c')+','+JSON.stringify(env.ALLOWED_ORIGIN).replace(/</g,'\\u003c')+');}';
  return new Response('<!doctype html><html lang="ja"><meta charset="utf-8"><title>Discordログイン</title><p>'+ (status===200?'ログイン確認が完了しました。元の画面へ戻ってください。':'ログインできませんでした。元の画面からやり直してください。')+'</p><script nonce="'+nonce+'">'+script+'</script></html>',{status,headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",...(setCookie?{'Set-Cookie':setCookie}:{})}});
}
export async function handleOAuth(request,env){
  const url=new URL(request.url),path=url.pathname,isCallback=path==='/api/oauth/callback';
  const origin=request.headers.get('Origin');
  const cors=origin===env.ALLOWED_ORIGIN?{'Access-Control-Allow-Origin':origin,Vary:'Origin'}:{};
  const reply=(error,status)=>Response.json({error:{code:error}},{status,headers:{...headers,...cors}});
  if(!hasAllowedHost(request))return reply('ORIGIN_REJECTED',403);
  if(!isCallback&&origin!==env.ALLOWED_ORIGIN)return reply('ORIGIN_REJECTED',403);
  if(!oauthConfigured(env))return path==='/api/oauth/start'&&request.method==='POST'?callbackPage(env,{error:'OAUTH_REJECTED'},503):reply('AUTH_NOT_CONFIGURED',503);
  let state,claim,clearCookie;
  try{
    if(isCallback){
      if(request.method!=='GET'||url.origin!==new URL(env.DISCORD_OAUTH_REDIRECT_URI).origin)throw new OperationError('OAUTH_REJECTED',400);
      if([...url.searchParams.keys()].some(k=>!['code','state','error','error_description','iss'].includes(k))||[...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length!==1))throw new OperationError('OAUTH_REJECTED',400);
      // Discord's RFC 9207 issuer is an exact identifier, not a URL to normalize or fetch.
      // Keep issuer-less callbacks compatible with this single-provider flow.
      if(url.searchParams.has('iss')&&url.searchParams.get('iss')!=='https://discord.com')throw new OperationError('OAUTH_REJECTED',400);
      state=url.searchParams.get('state');if(!HEX.test(state||''))throw new OperationError('OAUTH_REJECTED',400);
      clearCookie=cookie(state,'',0);
      const pairs=(request.headers.get('Cookie')||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(cookieName(state)+'='));
      const nonce=pairs.length===1?pairs[0].slice(cookieName(state).length+1):'';
      const consumed=await call(env,{action:'oauth.consume',state,nonce,nonceHash:await digest(nonce)});claim=consumed.claim;
      const code=url.searchParams.get('code');
      if(url.searchParams.has('error')||typeof code!=='string'||!code.length||code.length>2048||/[\s\x00-\x1f\x7f]/.test(code))throw new OperationError('OAUTH_REJECTED',400);
      const userId=await identify(env,code);
      const result=await call(env,{action:'oauth.finish',state,claim,userId});claim=null;
      return callbackPage(env,{state,handoff:result.handoff},200,clearCookie);
    }
    if(url.search)throw new OperationError('OAUTH_INPUT_INVALID',400);
    if(request.method!=='POST')return reply('METHOD_NOT_ALLOWED',405);
    if(path==='/api/oauth/start'){
      if(request.headers.get('Content-Type')?.split(';')[0]!=='application/x-www-form-urlencoded')throw new OperationError('OAUTH_INPUT_INVALID',400);
      const form=new URLSearchParams(await bodyText(request));
      if([...form.keys()].join(',')!=='challenge'||!HEX.test(form.get('challenge')||''))throw new OperationError('OAUTH_INPUT_INVALID',400);
      const result=await call(env,{action:'oauth.start',challenge:form.get('challenge')});
      const target=new URL('https://discord.com/oauth2/authorize');target.search=new URLSearchParams({response_type:'code',client_id:env.DISCORD_OAUTH_CLIENT_ID,scope:'identify',redirect_uri:env.DISCORD_OAUTH_REDIRECT_URI,state:result.state}).toString();
      return new Response(null,{status:303,headers:{...headers,Location:target.href,'Set-Cookie':cookie(result.state,result.nonce,300)}});
    }
    if(path==='/api/oauth/complete'){
      if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')throw new OperationError('OAUTH_INPUT_INVALID',400);
      const body=JSON.parse(await bodyText(request));
      if(!body||Object.keys(body).sort().join(',')!=='handoff,verifier'||!isHex(body.handoff)||!isHex(body.verifier))throw new OperationError('OAUTH_INPUT_INVALID',400);
      const result=await call(env,{action:'oauth.complete',...body});
      return Response.json(result,{headers:{...headers,...cors}});
    }
    return reply('ROUTE_NOT_FOUND',404);
  }catch(error){
    if(claim)await call(env,{action:'oauth.abort',state,claim}).catch(()=>{});
    // Never log upstream bodies, codes, cookies, IDs or tokens.
    const status=error instanceof OperationError?error.httpStatus:503;
    return isCallback||path==='/api/oauth/start'?callbackPage(env,{state:HEX.test(state||'')?state:null,error:'OAUTH_REJECTED'},status,clearCookie):reply('OAUTH_REJECTED',status);
  }
}
