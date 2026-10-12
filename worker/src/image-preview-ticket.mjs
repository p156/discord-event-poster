import {payloadHash,OperationError,PRINCIPAL,UUID} from './post-keys.mjs';
import {officialPolicy,allowedUrl} from './official-image-policy.mjs';
const enc=new TextEncoder(),domain='forum-image-preview:v1.',TTL=600000;
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const b64=b=>btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function key(secret){if(typeof secret!=='string'||secret.length<64)throw new OperationError('STATE_UNAVAILABLE',503);return crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function basePayloadHash(p){return payloadHash({apiVersion:1,threadName:p.threadName,content:p.content,tagIds:p.tagIds});}
export async function createPreviewClaims(p,result,forumId,now=Date.now()){return {v:1,ticketId:crypto.randomUUID(),principal:PRINCIPAL,forumId,basePayloadHash:await basePayloadHash(p),officialUrl:p.officialUrl,imageUrl:result.imageUrl,source:result.source,reasonCode:result.reasonCode,issuedAt:now,expiresAt:now+TTL};}
export async function signPreview(c,secret){const encoded=b64(enc.encode(JSON.stringify(c)));return 'ip1.'+encoded+'.'+hex(await crypto.subtle.sign('HMAC',await key(secret),enc.encode(domain+encoded)));}
export async function verifyPreview(ticket,secret,now=Date.now()){
 try{if(typeof ticket!=='string'||ticket.length>8192||!/^ip1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(ticket))throw Error();const [,encoded,sig]=ticket.split('.');
 const bytes=Uint8Array.from(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-encoded.length%4)%4)),c=>c.charCodeAt(0));
 if(!await crypto.subtle.verify('HMAC',await key(secret),Uint8Array.from(sig.match(/../g),x=>parseInt(x,16)),enc.encode(domain+encoded)))throw Error();
 const c=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(c.v!==1||!UUID.test(c.ticketId)||c.principal!==PRINCIPAL||!Number.isSafeInteger(c.issuedAt)||c.expiresAt-c.issuedAt!==TTL||now<c.issuedAt||now>=c.expiresAt)throw Error();
 if(c.imageUrl!==null){const policy=officialPolicy(c.officialUrl);if(!policy||allowedUrl(c.imageUrl,policy.imageHosts,{image:true})!==c.imageUrl||!['og:image','twitter:image'].includes(c.source))throw Error();}else if(c.source!==null)throw Error();return c;
 }catch(e){if(e instanceof OperationError&&e.code==='STATE_UNAVAILABLE')throw e;throw new OperationError('INVALID_PREVIEW_TICKET',409);}
}
export async function matchPreview(c,p,env){if(c.forumId!==env.DISCORD_FORUM_CHANNEL_ID||c.basePayloadHash!==await basePayloadHash(p)||c.officialUrl!==p.officialUrl||c.imageUrl!==p.imageUrl)throw new OperationError('INVALID_PREVIEW_TICKET',409);}
