import {randomHex,digest,SESSION_KEY,issueSession} from './auth-session.mjs';
import {scheduleEarlier} from './post-state.mjs';
import {OperationError} from './post-keys.mjs';
export const FLOW_KEY='auth:oauth2:flows',HANDOFF_KEY='auth:oauth2:handoffs';
const HEX=/^[a-f0-9]{64}$/;
const isHex=value=>typeof value==='string'&&HEX.test(value);
const reject=(status=401)=>{throw new OperationError('OAUTH_REJECTED',status);};
export async function cleanupOAuth(storage,now){
  let earliest=Infinity;
  for(const k of [SESSION_KEY,FLOW_KEY,HANDOFF_KEY,'auth:oauth2:starts','auth:oauth2:callbacks','auth:oauth2:completions']){
    const values=(await storage.get(k)||[]).filter(v=>(typeof v==='number'?v+300000:v.expires)>now);
    await storage.put(k,values);
    for(const v of values)earliest=Math.min(earliest,typeof v==='number'?v+300000:v.expires);
  }
  if(Number.isFinite(earliest))await scheduleEarlier(storage,earliest);
}
// AuthState serializes these local operations. There is no Discord fetch in the DO queue.
export async function oauthState(storage,env,input,now=Date.now()){
  if(input.action==='oauth.consume'||input.action==='oauth.complete'){
    const k=input.action==='oauth.consume'?'auth:oauth2:callbacks':'auth:oauth2:completions',limit=input.action==='oauth.consume'?120:60;
    const attempts=(await storage.get(k)||[]).filter(t=>t>now-300000);
    if(attempts.length>=limit)reject(429);
    await storage.put(k,[...attempts,now]);await scheduleEarlier(storage,now+300000);await storage.sync();
  }
  const result=await storage.transaction(async tx=>{
    now=Date.now();
    const flows=(await tx.get(FLOW_KEY)||[]).filter(f=>f.expires>now);
    const handoffs=(await tx.get(HANDOFF_KEY)||[]).filter(f=>f.expires>now);
    if(input.action==='oauth.start'){
      if(!isHex(input.challenge))reject(400);
      const starts=(await tx.get('auth:oauth2:starts')||[]).filter(t=>t>now-300000);
      if(starts.length>=20||flows.length>=20||handoffs.length>=20)reject(429);
      const state=randomHex(),nonce=randomHex();
      flows.push({state,nonceHash:await digest(nonce),challenge:input.challenge,expires:now+300000,status:'pending'});
      await tx.put(FLOW_KEY,flows);await tx.put('auth:oauth2:starts',[...starts,now]);
      return {state,nonce,expiresAt:now+300000};
    }
    if(input.action==='oauth.consume'){
      if(!isHex(input.state)||!isHex(input.nonce))reject();
      const flow=flows.find(f=>f.state===input.state&&f.status==='pending'&&f.nonceHash===input.nonceHash);
      if(!flow||flow.nonceHash!==await digest(input.nonce)||flow.expires<=Date.now())reject();
      flow.status='consumed';flow.claim=randomHex();await tx.put(FLOW_KEY,flows);
      return {claim:flow.claim};
    }
    if(input.action==='oauth.finish'||input.action==='oauth.abort'){
      const flow=flows.find(f=>f.state===input.state&&f.status==='consumed'&&f.claim===input.claim);
      if(!flow||flow.expires<=Date.now())reject();
      await tx.put(FLOW_KEY,flows.filter(f=>f!==flow));
      if(input.action==='oauth.abort')return {aborted:true};
      if(input.userId!==env.DISCORD_ALLOWED_USER_ID)reject();
      if(handoffs.length>=20)reject(429);
      const handoff=randomHex();
      handoffs.push({hash:await digest(handoff),challenge:flow.challenge,userId:input.userId,expires:now+60000});
      await tx.put(HANDOFF_KEY,handoffs);return {handoff,expiresAt:now+60000};
    }
    if(input.action==='oauth.complete'){
      if(!isHex(input.handoff)||!isHex(input.verifier))reject();
      const hash=await digest(input.handoff),ticket=handoffs.find(f=>f.hash===hash);
      if(!ticket)reject();
      // Consume even a failed proof. A ticket is never available after an attempt.
      await tx.put(HANDOFF_KEY,handoffs.filter(f=>f!==ticket));
      if(ticket.userId!==env.DISCORD_ALLOWED_USER_ID||ticket.challenge!==await digest(input.verifier)||ticket.expires<=Date.now())return {rejected:true};
      return {completeUserId:ticket.userId,deadline:ticket.expires};
    }
    reject(400);
  });
  await scheduleEarlier(storage,now+60000);await storage.sync();
  if(result.rejected)reject();
  if(result.completeUserId){
    if(result.completeUserId!==env.DISCORD_ALLOWED_USER_ID||result.deadline<=Date.now())reject();
    // The handoff consumption is durable BEFORE issuance. A storage failure cannot
    // roll the ticket back alongside a failed session write and enable replay.
    const session=await storage.transaction(tx=>issueSession(tx,env,Date.now()));
    await storage.sync();return session;
  }
  return result;
}
