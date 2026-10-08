const TAGS = ['周遊型','ホール型','ルーム型','オンライン','持ち帰り','イマーシブ','謎解き','ホラー'];
const enc = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), x=>x.toString(16).padStart(2,'0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g)||[], x=>parseInt(x,16));
const json = (value,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
async function signingKey(secret) { return crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']); }
export async function passwordHash(password,salt,iterations=600000) {
  const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:unhex(salt),iterations},key,256));
}
function equal(a,b) { let diff=a.length^b.length; for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0); return diff===0; }
async function tokenFor(id,expires,key) { const message=id+'.'+expires; return message+'.'+hex(await crypto.subtle.sign('HMAC',await signingKey(key),enc.encode(message))); }
async function verifyToken(token,key) {
  const parts=token.split('.'); if(parts.length!==3||!/^[a-f0-9]{64}$/.test(parts[0])||!/^\d{13}$/.test(parts[1])||!/^[a-f0-9]{64}$/.test(parts[2])||Number(parts[1])<=Date.now())return null;
  if(!await crypto.subtle.verify('HMAC',await signingKey(key),unhex(parts[2]),enc.encode(parts[0]+'.'+parts[1])))return null;
  return {id:parts[0],expires:Number(parts[1])};
}
export class AuthState {
  constructor(state,env) { this.storage=state.storage; this.env=env; this.queue=Promise.resolve(); }
  // Serialize the entire authentication operation, including PBKDF2 and storage awaits.
  fetch(request) { const operation=this.queue.then(()=>this.handle(request)); this.queue=operation.catch(()=>{}); return operation; }
  alarm() { const operation=this.queue.then(async()=>{const now=Date.now();const sessions=(await this.storage.get('sessions')||[]).filter(s=>s.expires>now);const attempts=(await this.storage.get('attempts')||[]).filter(t=>t>now-900000);await this.storage.put('sessions',sessions);await this.storage.put('attempts',attempts);if(sessions.length||attempts.length)await this.storage.setAlarm(now+3600000);});this.queue=operation.catch(()=>{});return operation; }
  async handle(request) {
    const {action,password,token}=await request.json(); const now=Date.now();
    const sessions=(await this.storage.get('sessions')||[]).filter(s=>s.expires>now);
    if(action==='login') {
      const attempts=(await this.storage.get('attempts')||[]).filter(t=>t>now-900000);
      if(attempts.length>=5)return json({error:'ログイン試行上限です。15分後に再試行してください。'},429);
      attempts.push(now); await this.storage.put('attempts',attempts); await this.storage.setAlarm(now+3600000);
      const [algorithm,iterations,salt,expected]=this.env.APP_PASSWORD_HASH.split('$');
      const actual=await passwordHash(password,salt,Number(iterations));
      if(!equal(actual,expected))return json({error:'認証できませんでした。'},401);
      const id=hex(crypto.getRandomValues(new Uint8Array(32))),expires=now+3600000;
      sessions.push({id,expires}); await this.storage.put('sessions',sessions.slice(-20));
      return json({token:await tokenFor(id,expires,this.env.SESSION_SIGNING_KEY),expiresAt:expires});
    }
    const verified=await verifyToken(token||'',this.env.SESSION_SIGNING_KEY);
    if(!verified||!sessions.some(s=>s.id===verified.id&&s.expires===verified.expires))return json({error:'ログインし直してください。'},401);
    if(action==='logout')await this.storage.put('sessions',sessions.filter(s=>s.id!==verified.id));
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
  return env.AUTH_STATE&&/^pbkdf2-sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(env.APP_PASSWORD_HASH||'')&&typeof env.SESSION_SIGNING_KEY==='string'&&env.SESSION_SIGNING_KEY.length>=64&&/^\d{1,20}$/.test(env.DISCORD_FORUM_CHANNEL_ID||'')&&env.DISCORD_BOT_TOKEN;
}
async function auth(env,payload) { const stub=env.AUTH_STATE.get(env.AUTH_STATE.idFromName('personal-auth-v1'));return stub.fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify(payload)})); }
async function discord(env,path) {
  const response=await fetch('https://discord.com/api/v10/'+path,{headers:{Authorization:'Bot '+env.DISCORD_BOT_TOKEN},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)return null;return response.json();
}
export default {
  async fetch(request,env) {
    const origin=request.headers.get('Origin');
    if(!origin||origin!==env.ALLOWED_ORIGIN)return json({error:'アクセスできません。'},403);
    const headers={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    let response;
    try {
      const url=new URL(request.url),path=url.pathname;
      if(url.search)response=json({error:'パラメーターは利用できません。'},400);
      else if(request.method==='OPTIONS') {
        const method=request.headers.get('Access-Control-Request-Method');
        const requested=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
        if(!['GET','POST'].includes(method)||requested.some(h=>!['authorization','content-type'].includes(h)))response=json({error:'アクセスできません。'},403);
        else response=new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'}});
      } else if(!configured(env))response=json({error:'認証サービスの設定が完了していません。'},503);
      else if(path==='/api/login'&&request.method==='POST') {
        let body;try{body=await smallJson(request);}catch{return new Response(JSON.stringify({error:'入力を確認してください。'}),{status:400,headers:{...headers,'Content-Type':'application/json'}});}
        if(typeof body.password!=='string'||body.password.length<1||body.password.length>256)response=json({error:'入力を確認してください。'},400);
        else response=await auth(env,{action:'login',password:body.password});
      } else if((path==='/api/logout'&&request.method==='POST')||(path==='/api/session'&&request.method==='GET')||(path==='/api/forum/tags'&&request.method==='GET')||(path==='/api/forum/webhook-check'&&request.method==='POST')) {
        const token=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9.]{1,160})$/)?.[1]||'';
        response=await auth(env,{action:path==='/api/logout'?'logout':'check',token});
        if(response.ok&&path==='/api/forum/tags') {
          const channel=await discord(env,'channels/'+env.DISCORD_FORUM_CHANNEL_ID);
          if(!channel||channel.id!==env.DISCORD_FORUM_CHANNEL_ID||channel.type!==15||!Array.isArray(channel.available_tags))response=json({error:'Discordフォーラムを取得できませんでした。'},502);
          else {
            const tags=channel.available_tags.map(t=>({id:t.id,name:t.name}));const mapping={},missing=[],duplicates=[];
            for(const name of TAGS){const matches=tags.filter(t=>t.name===name);if(matches.length===0)missing.push(name);else if(matches.length>1)duplicates.push(name);else if(/^\d{1,20}$/.test(matches[0].id))mapping[name]=matches[0].id;else missing.push(name);}
            response=json({forumId:channel.id,tags,mapping,missing,duplicates,unknown:tags.filter(t=>!TAGS.includes(t.name)).map(t=>t.name)});
          }
        } else if(response.ok&&path==='/api/forum/webhook-check') {
          const body=await smallJson(request);
          if(typeof body.webhookId!=='string'||!/^\d{1,20}$/.test(body.webhookId))response=json({error:'Webhook IDを確認してください。'},400);
          else {
            // Only list webhooks belonging to the fixed forum; never proxy arbitrary API routes.
            const hooks=await discord(env,'channels/'+env.DISCORD_FORUM_CHANNEL_ID+'/webhooks');
            response=!Array.isArray(hooks)?json({error:'Webhookの所属確認に失敗しました。'},502):hooks.some(h=>h.id===body.webhookId&&h.type===1&&h.channel_id===env.DISCORD_FORUM_CHANNEL_ID)?json({forumId:env.DISCORD_FORUM_CHANNEL_ID,webhookId:body.webhookId}):json({error:'対象フォーラムのWebhookではありません。'},409);
          }
        }
      } else response=json({error:'APIが見つかりません。'},404);
    } catch { response=json({error:'処理を完了できませんでした。'},503); }
    const result=new Response(response.body,response);for(const [key,value]of Object.entries(headers))result.headers.set(key,value);return result;
  }
};
