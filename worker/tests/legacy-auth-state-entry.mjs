// Migration fixture for the previous persisted v1 storage shape, not a production entrypoint.
import {postState,cleanupPosts} from '../src/post-state.mjs';
import {signOperation,payloadHash} from '../src/post-keys.mjs';
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
export class AuthState {
  constructor(state,env){this.storage=state.storage;this.env=env;}
  alarm(){return cleanupPosts(this.storage,Date.now());}
  async fetch(){
    const id=hex(crypto.getRandomValues(new Uint8Array(32))),expires=Date.now()+3600000,message=id+'.'+expires;
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(this.env.SESSION_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const token=message+'.'+hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(message)));
    await this.storage.put('sessions',[{id,expires}]);await this.storage.put('attempts',[Date.now()]);
    const issued=await postState(this.storage,this.env,{action:'post.issue',payloadHash:await payloadHash({apiVersion:1,threadName:'TEST_ONLY',content:'TEST_ONLY',tagIds:[]})});
    const recordKey='posts:operation:'+issued.claims.operationId,record=await this.storage.get(recordKey);
    record.status='succeeded';record.safeToRetry=false;record.attempt=1;record.result={guildId:'456',forumId:'123',threadId:'789',messageId:'790',threadUrl:'https://discord.com/channels/456/789',url:'https://discord.com/channels/456/789/790'};
    await this.storage.put(recordKey,record);await this.storage.put('posts:rate-initialized',true);await this.storage.put('posts:rate',{slots:[Date.now()],lastNow:Date.now()});
    await this.storage.sync();
    return Response.json({token,operationId:record.operationId,idempotencyKey:await signOperation(issued.claims,this.env.SESSION_SIGNING_KEY),record});
  }
}
export default {fetch(request,env){return env.AUTH_STATE.get(env.AUTH_STATE.idFromName('personal-auth-v1')).fetch('https://internal/test-seed');}};
