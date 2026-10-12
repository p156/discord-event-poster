import {OperationError,UUID} from './post-keys.mjs';
import {authenticatedSession} from './auth-session.mjs';
import {scheduleEarlier} from './post-state.mjs';
const rateKey='images:rate',ticketKey=id=>'images:ticket:'+id;
export async function cleanupImages(storage,now){const entries=await storage.list({prefix:'images:ticket:',limit:256});let next=null;for(const [k,v]of entries){if(v.expiresAt<=now)await storage.delete(k);else next=Math.min(next??v.expiresAt,v.expiresAt);}if(next)await scheduleEarlier(storage,next);}
export async function imageState(storage,env,input,now=Date.now()){
 await cleanupImages(storage,now);
 const result=await storage.transaction(async tx=>{
  if(!await authenticatedSession(tx,env,input.token))throw new OperationError('SESSION_EXPIRED',401);now=Date.now();
  if(input.action==='image.reserve'){
   const r=await tx.get(rateKey)||{slots:[],leases:[],lastNow:0};const t=Math.max(now,r.lastNow);r.lastNow=t;r.slots=r.slots.filter(x=>x>t-60000);r.leases=r.leases.filter(x=>x.until>t);
   if(r.slots.length>=10||r.leases.length>=2)throw new OperationError('IMAGE_RATE_LIMITED',429);
   const leaseId=crypto.randomUUID();r.slots.push(t);r.leases.push({id:leaseId,until:t+20000});await tx.put(rateKey,r);return {leaseId};
  }
  if(input.action==='image.release'){const r=await tx.get(rateKey);if(r){r.leases=r.leases.filter(x=>x.id!==input.leaseId);await tx.put(rateKey,r);}return {};}
  if(input.action==='image.register'){
   const c=input.preview;if(!c||!UUID.test(c.ticketId)||c.expiresAt<=now||c.expiresAt>now+600000)throw new OperationError('INVALID_PREVIEW_TICKET',409);
   if(input.replaceId){const old=await tx.get(ticketKey(input.replaceId));if(!old||old.used||old.expiresAt<=now)throw new OperationError('INVALID_PREVIEW_TICKET',409);old.used=true;await tx.put(ticketKey(input.replaceId),old);}
   const tickets=await tx.list({prefix:'images:ticket:',limit:201});if(tickets.size>=200)throw new OperationError('IMAGE_RATE_LIMITED',429);
   await tx.put(ticketKey(c.ticketId),{preview:c,expiresAt:c.expiresAt,used:false});return {};
  }
  if(input.action==='image.check'){const r=await tx.get(ticketKey(input.ticketId));if(!r||r.used||r.expiresAt<=now)throw new OperationError('INVALID_PREVIEW_TICKET',409);return {};}
  throw new OperationError('INVALID_REQUEST');
 });
 if(input.preview)await scheduleEarlier(storage,input.preview.expiresAt);await storage.sync();return result;
}
// Must run in the same durable transaction as post.issue; never reuse a ticket.
export async function consumePreview(tx,env,token,c,now){
 if(!await authenticatedSession(tx,env,token))throw new OperationError('SESSION_EXPIRED',401);
 const stored=await tx.get(ticketKey(c.ticketId));if(!stored||stored.used||c.expiresAt<=now||JSON.stringify(stored.preview)!==JSON.stringify(c))throw new OperationError('INVALID_PREVIEW_TICKET',409);
 stored.used=true;await tx.put(ticketKey(c.ticketId),stored);
}
