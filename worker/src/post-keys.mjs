import {validatePostPayload,isSnowflake} from './forum-input.mjs';
export const RETENTION_MS=30*24*60*60*1000;
export const PRINCIPAL='personal-owner-v1';
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const enc=new TextEncoder(),domain='forum-post-operation:v1.';
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const unhex=s=>Uint8Array.from(s.match(/../g),x=>parseInt(x,16));
const b64=b=>btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function key(secret){if(typeof secret!=='string'||secret.length<64)throw new OperationError('STATE_UNAVAILABLE',503);return crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export class OperationError extends Error {constructor(code,status=400){super(code);this.code=code;this.httpStatus=status;}}
export async function payloadHash(raw){const p=validatePostPayload(raw);return hex(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify([1,p.threadName,p.content,p.tagIds]))));}
export function canonicalClaims(c){return JSON.stringify({v:c.v,operationId:c.operationId,principal:c.principal,forumId:c.forumId,payloadHash:c.payloadHash,issuedAt:c.issuedAt,expiresAt:c.expiresAt});}
export function validateClaims(c){
  if(!c||Object.keys(c).sort().join(',')!=='expiresAt,forumId,issuedAt,operationId,payloadHash,principal,v'||c.v!==1||typeof c.operationId!=='string'||!UUID.test(c.operationId)||c.principal!==PRINCIPAL||!isSnowflake(c.forumId)||typeof c.payloadHash!=='string'||!/^[a-f0-9]{64}$/.test(c.payloadHash)||!Number.isSafeInteger(c.issuedAt)||c.issuedAt<0||!Number.isSafeInteger(c.expiresAt)||c.expiresAt-c.issuedAt!==RETENTION_MS)throw new OperationError('INVALID_OPERATION_KEY');
  return c;
}
export async function signOperation(c,secret){validateClaims(c);const claims=b64(enc.encode(canonicalClaims(c)));return 'v1.'+claims+'.'+hex(await crypto.subtle.sign('HMAC',await key(secret),enc.encode(domain+claims)));}
export async function verifyOperation(ticket,secret,now=Date.now()){
  if(typeof ticket!=='string'||ticket.length>1024||!/^v1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(ticket))throw new OperationError('INVALID_OPERATION_KEY');
  const [,encoded,signature]=ticket.split('.');let claims;
  try{const bytes=Uint8Array.from(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-encoded.length%4)%4)),c=>c.charCodeAt(0));claims=validateClaims(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));if(b64(enc.encode(canonicalClaims(claims)))!==encoded)throw new Error();}catch{throw new OperationError('INVALID_OPERATION_KEY');}
  if(!await crypto.subtle.verify('HMAC',await key(secret),unhex(signature),enc.encode(domain+encoded)))throw new OperationError('INVALID_OPERATION_KEY');
  if(now<claims.issuedAt)throw new OperationError('INVALID_OPERATION_KEY');
  if(now>=claims.expiresAt)throw new OperationError('OPERATION_EXPIRED',410);
  return claims;
}
// Separate domain from both Bearer and operation-ticket signatures. Never logged.
export async function internalProof(body,secret){return hex(await crypto.subtle.sign('HMAC',await key(secret),enc.encode('forum-post-internal:v1.'+JSON.stringify(body))));}
export async function verifyInternal(body,proof,secret){return typeof proof==='string'&&/^[a-f0-9]{64}$/.test(proof)&&await crypto.subtle.verify('HMAC',await key(secret),unhex(proof),enc.encode('forum-post-internal:v1.'+JSON.stringify(body)));}
