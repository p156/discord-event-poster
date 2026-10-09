import {AuthState} from '../src/index.mjs';
import {createPostHandler} from '../src/post-handler.mjs';
import {internalProof} from '../src/post-keys.mjs';
export class TestStorage {
  constructor(){this.data=new Map();this.alarm=null;this.fail=null;this.events=[];this.transactionTail=Promise.resolve();}
  async get(k){return structuredClone(this.data.get(k));}
  async put(k,v){this.events.push('put:'+k);if(this.fail?.(k,v))throw new Error('PRIVATE_STORAGE_ERROR');this.data.set(k,structuredClone(v));}
  async delete(k){return this.data.delete(k);}
  async getAlarm(){return this.alarm;}
  async setAlarm(at){this.alarm=at;}
  async sync(){this.events.push('sync');if(this.fail?.('sync'))throw new Error('PRIVATE_SYNC_ERROR');}
  async list({prefix='',end='\uffff',limit=1000}={}){return new Map([...this.data].filter(([k])=>k.startsWith(prefix)&&k<end).sort(([a],[b])=>a<b?-1:1).slice(0,limit).map(([k,v])=>[k,structuredClone(v)]));}
  transaction(fn){const next=this.transactionTail.then(async()=>{const saved=structuredClone(this.data);try{return await fn(this);}catch(e){this.data=saved;throw e;}});this.transactionTail=next.catch(()=>{});return next;}
}
export const payload=()=>({apiVersion:1,threadName:'題',content:'PRIVATE_EVENT_BODY',tagIds:[]});
export const forum=()=>({id:'123',guild_id:'456',type:15,flags:0,available_tags:[]});
export const receipt=()=>({id:'789',type:11,parent_id:'123',guild_id:'456',message:{id:'790',channel_id:'789'}});
export async function fixture({storage=new TestStorage(),post,preflight,timeoutMs}={}){
  const env={ALLOWED_ORIGIN:'https://poster.example',DISCORD_BOT_TOKEN:'PRIVATE_TEST_BOT',DISCORD_FORUM_CHANNEL_ID:'123',SESSION_SIGNING_KEY:'a'.repeat(64)};
  const h={env,storage,calls:[],writes:0,post,preflight};
  h.object=new AuthState({storage},env);env.AUTH_STATE={idFromName:n=>{if(n!=='personal-auth-v1')throw new Error('Wrong scope');return 0;},get:()=>({fetch:r=>h.object.fetch(r)})};
  h.session=async()=>{const id=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join(''),expires=Date.now()+3600000;const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.SESSION_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(id+'.'+expires))),x=>x.toString(16).padStart(2,'0')).join('');await storage.put('sessions',[...await storage.get('sessions')||[],{id,expires}]);return id+'.'+expires+'.'+signature;};
  h.token=await h.session();
  h.handler=createPostHandler({timeoutMs,fetchImpl:async(url,opts)=>{h.calls.push({url,opts});if(opts.method==='POST'){h.writes++;storage.events.push('DISCORD_WRITE');return h.post?h.post(url,opts):Response.json(receipt());}return h.preflight?h.preflight(url,opts):Response.json(forum());}});
  h.request=(path,method='POST',body=payload(),key,token=h.token,headers={})=>new Request('https://discord-event-poster-api.monma5435.workers.dev'+path,{method,headers:{Origin:env.ALLOWED_ORIGIN,Authorization:'Bearer '+token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{}),...headers},...(method==='POST'?{body:JSON.stringify(body)}:{})});
  h.call=(...args)=>h.handler(h.request(...args),env);
  h.issue=async(p=payload())=>{const r=await h.call('/api/forum/post-intents','POST',p);return {response:r,...await r.json()};};
  h.submit=(i,p=payload(),token=h.token)=>h.call('/api/forum/posts','POST',p,i.idempotencyKey,token);
  h.status=(i,token=h.token)=>h.call('/api/forum/posts/'+i.operationId,'GET',null,i.idempotencyKey,token);
  h.internal=async(action,i,extra={})=>{const body={action,token:h.token,claims:i.claims,...extra};return h.object.fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify({...body,proof:await internalProof(body,env.SESSION_SIGNING_KEY)})}));};
  h.restart=()=>{h.object=new AuthState({storage},env);};
  return h;
}
