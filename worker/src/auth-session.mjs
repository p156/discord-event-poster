// OAuth sessions have a separate key and signature domain from operation tickets.
import {isSnowflake} from './forum-input.mjs';
export const SESSION_KEY='auth:oauth2:sessions';
export const SESSION_MS=3600000;
export const TOKEN_PATTERN=/^oauth2\.[a-f0-9]{64}\.\d{13}\.[a-f0-9]{64}$/;
const enc=new TextEncoder();
export const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
export const randomHex=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest=async value=>hex(await crypto.subtle.digest('SHA-256',enc.encode(value)));
const key=secret=>crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
export function sessionConfigured(env){return isSnowflake(env.DISCORD_ALLOWED_USER_ID)&&typeof env.AUTH_SESSION_SIGNING_KEY==='string'&&env.AUTH_SESSION_SIGNING_KEY.length>=64&&env.AUTH_SESSION_SIGNING_KEY!==env.SESSION_SIGNING_KEY;}
export async function issueSession(storage,env,now=Date.now()){
  if(!sessionConfigured(env))throw new Error('AUTH_NOT_CONFIGURED');
  const id=randomHex(),expires=now+SESSION_MS,message='oauth2.'+id+'.'+expires;
  const token=message+'.'+hex(await crypto.subtle.sign('HMAC',await key(env.AUTH_SESSION_SIGNING_KEY),enc.encode('app-session:oauth2:v1.'+message)));
  const sessions=(await storage.get(SESSION_KEY)||[]).filter(s=>s.expires>now);
  await storage.put(SESSION_KEY,[...sessions,{id,issuedAt:now,expires,userId:env.DISCORD_ALLOWED_USER_ID,method:'discord-oauth2'}].slice(-20));
  return {token,expiresAt:expires};
}
export async function authenticatedSession(storage,env,token){
  if(!sessionConfigured(env)||typeof token!=='string'||!TOKEN_PATTERN.test(token))return null;
  const [,id,expiry,signature]=token.split('.'),expires=Number(expiry);
  if(expires<=Date.now())return null;
  const bytes=Uint8Array.from(signature.match(/../g),v=>parseInt(v,16));
  if(!await crypto.subtle.verify('HMAC',await key(env.AUTH_SESSION_SIGNING_KEY),bytes,enc.encode('app-session:oauth2:v1.'+token.slice(0,token.lastIndexOf('.')))))return null;
  const sessions=await storage.get(SESSION_KEY)||[];
  const s=sessions.find(s=>s.id===id&&s.expires===expires&&s.method==='discord-oauth2'&&s.userId===env.DISCORD_ALLOWED_USER_ID&&Number.isSafeInteger(s.issuedAt)&&s.expires-s.issuedAt===SESSION_MS);
  return s&&s.issuedAt<=Date.now()&&s.expires>Date.now()?s:null;
}
export async function migrateAuthentication(storage){
  if(await storage.get('auth:oauth2:migrated'))return;
  await storage.transaction(async tx=>{
    await tx.delete('sessions');await tx.delete('attempts');
    await tx.put('auth:oauth2:migrated',true);
  });
  await storage.sync();
}
