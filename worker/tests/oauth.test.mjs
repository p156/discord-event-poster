import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{AuthState} from '../src/index.mjs';
import {fixture,payload} from './post-fixtures.mjs';
import {BASE,startFlow,finishFlow,mockLogin,discordOAuthMock} from './oauth-fixtures.mjs';
import {SESSION_KEY,SESSION_MS,digest,hex} from '../src/auth-session.mjs';
import {FLOW_KEY,HANDOFF_KEY} from '../src/oauth-state.mjs';
async function setup(){const h=await fixture();h.env.FORUM_POSTS_ENABLED='true';h.dispatch=(url,opts)=>worker.fetch(new Request(url,opts),h.env);h.start=()=>startFlow(h.dispatch,h.env.ALLOWED_ORIGIN);h.complete=(handoff,verifier)=>h.dispatch(BASE+'/api/oauth/complete',{method:'POST',headers:{Origin:h.env.ALLOWED_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({handoff,verifier})});return h;}
async function withMock(run,mock=discordOAuthMock){const real=globalThis.fetch;globalThis.fetch=mock;try{return await run();}finally{globalThis.fetch=real;}}
async function callback(h,flow,code='TEST_ONLY_CODE',headers={Cookie:flow.cookie}){return h.dispatch(BASE+'/api/oauth/callback?'+new URLSearchParams({state:flow.state,code}),{headers});}
async function ticket(h,flow){const r=await callback(h,flow);assert.equal(r.status,200);return (await r.text()).match(/"handoff":"([a-f0-9]{64})"/)[1];}
test('identify only, confidential exchange, own ID, no OAuth secrets/tokens in browser packet',()=>withMock(async()=>{
 const h=await setup(),flow=await h.start();const session=await finishFlow(h.dispatch,flow,h.env.ALLOWED_ORIGIN);
 assert.match(session.token,/^oauth2\./);assert.ok(session.expiresAt>Date.now());assert.ok(session.expiresAt<=Date.now()+SESSION_MS);
 assert.deepEqual(Object.keys(session).sort(),['expiresAt','token']);assert.ok(!JSON.stringify(session).includes('TEST_ONLY'));
 const s=await h.storage.get(SESSION_KEY);assert.equal(s.at(-1).expires-s.at(-1).issuedAt,SESSION_MS);assert.equal(s.at(-1).userId,'222');
 const saved=JSON.stringify([...h.storage.data]);for(const secret of ['TEST_ONLY_OAUTH_TOKEN','TEST_ONLY_REFRESH','TEST_ONLY_OAUTH_SECRET','TEST_ONLY_CODE'])assert.ok(!saved.includes(secret));
}));
test('unknown Discord user never gets a ticket or session; replay denied',()=>withMock(async()=>{
 const h=await setup(),flow=await h.start(),before=(await h.storage.get(SESSION_KEY)).length;
 const r=await callback(h,flow);assert.equal(r.status,403);assert.ok(!(await r.text()).includes('handoff'));assert.equal((await h.storage.get(SESSION_KEY)).length,before);
 assert.equal((await callback(h,flow)).status,401);assert.equal((await h.storage.get(HANDOFF_KEY)||[]).length,0);
},(url,opts)=>String(url).endsWith('/users/@me')?Response.json({id:'333'}):discordOAuthMock(url,opts)));
test('session checks never extend expiry, expires exactly at one hour, owner change rejects',()=>withMock(async()=>{
 const h=await setup(),s=await mockLogin(h.dispatch,h.env.ALLOWED_ORIGIN),original=Date.now;try{
 const call=()=>h.dispatch(BASE+'/api/session',{headers:{Origin:h.env.ALLOWED_ORIGIN,Authorization:'Bearer '+s.token}});
 Date.now=()=>s.expiresAt-1;assert.equal((await call()).status,200);assert.equal((await h.storage.get(SESSION_KEY)).at(-1).expires,s.expiresAt);
 Date.now=()=>s.expiresAt;assert.equal((await call()).status,401);
 Date.now=original;h.env.DISCORD_ALLOWED_USER_ID='333';assert.equal((await call()).status,401);
 }finally{Date.now=original;}
}));
test('old password route and all old Bearer sessions rejected; existing signing key preserved',async()=>{
 const h=await setup(),expiry=Date.now()+SESSION_MS,id='a'.repeat(64),msg=id+'.'+expiry;
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(h.env.SESSION_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const old=msg+'.'+hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(msg)));
 await h.storage.put('sessions',[{id,expires:expiry}]);await h.storage.put('attempts',[Date.now()]);const retained=h.env.SESSION_SIGNING_KEY;
 assert.equal((await h.dispatch(BASE+'/api/login',{method:'POST',headers:{Origin:h.env.ALLOWED_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({password:'TEST_ONLY'})})).status,404);
 for(const path of ['/api/session','/api/forum/tags','/api/forum/post-intents','/api/forum/posts','/api/logout','/api/forum/webhook-check']){
 const method=['/api/session','/api/forum/tags'].includes(path)?'GET':'POST';assert.equal((await h.dispatch(BASE+path,{method,headers:{Origin:h.env.ALLOWED_ORIGIN,Authorization:'Bearer '+old,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(payload())}:{})})).status,401);
 }
 await h.start();assert.equal(await h.storage.get('sessions'),undefined);assert.equal(await h.storage.get('attempts'),undefined);assert.equal(h.env.SESSION_SIGNING_KEY,retained);
 assert.equal((await h.object.fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify({action:'login',password:'TEST_ONLY'})}))).status,404);
});
test('concurrent callbacks and concurrent completion each admit exactly once',()=>withMock(async()=>{
 const h=await setup(),flow=await h.start();const replies=await Promise.all([callback(h,flow),callback(h,flow)]);assert.equal(replies.filter(r=>r.status===200).length,1);assert.equal(replies.filter(r=>r.status===401).length,1);
 const html=await replies.find(r=>r.status===200).text(),handoff=html.match(/"handoff":"([a-f0-9]{64})"/)[1];
 const complete=await Promise.all([h.complete(handoff,flow.verifier),h.complete(handoff,flow.verifier)]);assert.equal(complete.filter(r=>r.status===200).length,1);assert.equal(complete.filter(r=>r.status===401).length,1);
}));
test('handoff is bound to initiating tab proof; failed proof consumes ticket',()=>withMock(async()=>{
 const h=await setup(),flow=await h.start(),handoff=await ticket(h,flow);
 assert.equal((await h.complete(handoff,'f'.repeat(64))).status,401);assert.equal((await h.complete(handoff,flow.verifier)).status,401);
}));
test('state/browser cookie mismatch, absent cookie, forged internal OAuth command reject',()=>withMock(async()=>{
 const h=await setup(),a=await h.start(),b=await h.start();assert.notEqual(a.cookie.split('=')[0],b.cookie.split('=')[0]);
 assert.equal((await callback(h,a,'TEST_ONLY_CODE',{})).status,401);assert.equal((await callback(h,a,'TEST_ONLY_CODE',{Cookie:b.cookie})).status,401);
 assert.equal((await callback(h,a,'TEST_ONLY_CODE',{Cookie:a.cookie+'; '+a.cookie})).status,401);
 assert.equal((await h.object.fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify({action:'oauth.finish',state:a.state,claim:'a'.repeat(64),userId:'222'})}))).status,403);
 assert.equal((await callback(h,a)).status,200);
}));
test('flow/handoff expiration and cancellation cannot be reused',()=>withMock(async()=>{
 const h=await setup(),original=Date.now;try{
 const f=await h.start(),expires=(await h.storage.get(FLOW_KEY))[0].expires;Date.now=()=>expires;assert.equal((await callback(h,f)).status,401);Date.now=original;
 const g=await h.start(),handoff=await ticket(h,g),deadline=(await h.storage.get(HANDOFF_KEY))[0].expires;Date.now=()=>deadline;assert.equal((await h.complete(handoff,g.verifier)).status,401);Date.now=original;
 const c=await h.start();const r=await h.dispatch(BASE+'/api/oauth/callback?'+new URLSearchParams({state:c.state,error:'access_denied'}),{headers:{Cookie:c.cookie}});assert.equal(r.status,400);assert.equal((await callback(h,c)).status,401);
 }finally{Date.now=original;}
}));
test('callback exception is narrow; duplicate/query injection/wrong host/origin/method reject',async()=>{
 const h=await setup(),f=await h.start();for(const url of [BASE+'/api/oauth/callback?state='+f.state+'&state='+f.state,BASE+'/api/oauth/callback?state='+f.state+'&redirect_uri=https://evil.invalid','https://evil.invalid/api/oauth/callback?state='+f.state])assert.ok((await h.dispatch(url,{headers:{Cookie:f.cookie}})).status>=400);
 assert.equal((await h.dispatch(BASE+'/api/session')).status,403);
 assert.equal((await h.dispatch(BASE+'/api/oauth/start',{method:'POST',headers:{Origin:'https://evil.invalid'},body:'challenge='+'e'.repeat(64)})).status,403);
 assert.equal((await h.dispatch(BASE+'/api/oauth/callback',{method:'POST',headers:{Origin:h.env.ALLOWED_ORIGIN},body:'code=x'})).status,400);
});
test('every missing OAuth setting fails closed, no legacy fallback, equal signing keys rejected',async()=>{
 for(const name of ['DISCORD_ALLOWED_USER_ID','AUTH_SESSION_SIGNING_KEY','DISCORD_OAUTH_CLIENT_ID','DISCORD_OAUTH_CLIENT_SECRET','DISCORD_OAUTH_REDIRECT_URI','SESSION_SIGNING_KEY']){
 const h=await setup();delete h.env[name];const r=await h.dispatch(BASE+'/api/oauth/start',{method:'POST',headers:{Origin:h.env.ALLOWED_ORIGIN,'Content-Type':'application/x-www-form-urlencoded'},body:'challenge='+'a'.repeat(64)});assert.equal(r.status,503,name);
 assert.equal((await h.dispatch(BASE+'/api/login',{method:'POST',headers:{Origin:h.env.ALLOWED_ORIGIN},body:'password=x'})).status,404);
 }
 const h=await setup();h.env.AUTH_SESSION_SIGNING_KEY=h.env.SESSION_SIGNING_KEY;assert.equal((await h.dispatch(BASE+'/api/session',{headers:{Origin:h.env.ALLOWED_ORIGIN}})).status,503);
});
test('OAuth upstream failures/rejected tokens are sanitized and consumed, never redirect-followed',async()=>{
 const variants=[()=>new Response(null,{status:302,headers:{Location:'https://evil.invalid'}}),()=>new Response('PRIVATE_BODY',{status:429}),()=>new Response('PRIVATE_BODY',{status:500}),()=>new Response('PRIVATE_BODY',{headers:{'Content-Type':'application/json'}}),()=>Response.json({access_token:'TEST_ONLY_OAUTH_TOKEN',token_type:'Bearer',scope:'email',expires_in:600}),()=>Response.json({access_token:'x\r\nsecret',token_type:'Bearer',scope:'identify',expires_in:600}),()=>new Response('x'.repeat(16385),{headers:{'Content-Type':'application/json'}})];
 for(const variant of variants)await withMock(async()=>{
 const h=await setup(),flow=await h.start(),r=await callback(h,flow);assert.equal(r.status,503);const html=await r.text();assert.ok(!html.includes('PRIVATE_BODY'));assert.ok(!html.includes('TEST_ONLY_OAUTH_TOKEN'));assert.equal((await callback(h,flow)).status,401);
 },(url,opts)=>{assert.equal(url,'https://discord.com/api/oauth2/token');assert.equal(opts.redirect,'manual');return variant();});
});
test('callback CSP/cache/referrer protections; token never in Location or callback HTML',()=>withMock(async()=>{
 const h=await setup(),flow=await h.start(),r=await callback(h,flow),html=await r.text();
 assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('Referrer-Policy'),'no-referrer');assert.match(r.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);assert.match(r.headers.get('Set-Cookie'),/Max-Age=0/);assert.ok(!html.includes('TEST_ONLY_OAUTH_TOKEN'));assert.ok(!html.includes('oauth2.'));assert.match(html,/history.replaceState/);
}));
test('migration retains posts, old operation signatures, cooldown and re-login inspection',()=>withMock(async()=>{
 const h=await setup(),i=await h.issue(),saved=await h.storage.get('posts:operation:'+i.operationId);await h.storage.put('discord:sentinel',{until:Date.now()+60000});
 await h.storage.put('sessions',[{id:'a'.repeat(64),expires:Date.now()+SESSION_MS}]);await h.storage.put('attempts',[Date.now()]);await h.storage.delete('auth:oauth2:migrated');
 const s=await mockLogin(h.dispatch,h.env.ALLOWED_ORIGIN);h.token=s.token;assert.equal((await h.status(i)).status,200);assert.deepEqual(await h.storage.get('posts:operation:'+i.operationId),saved);assert.ok(await h.storage.get('discord:sentinel'));assert.equal(await h.storage.get('sessions'),undefined);
 h.restart();assert.equal((await h.status(i)).status,200);await h.object.alarm();assert.ok(await h.storage.get('posts:operation:'+i.operationId));
}));
test('storage/transaction/sync failure cannot issue a usable session; migration retry keeps posts',async()=>{
 for(const fail of ['auth:oauth2:migrated',FLOW_KEY,'sync']){const h=await setup();await h.storage.put('posts:sentinel',{keep:true});h.storage.fail=k=>k===fail;const r=await h.dispatch(BASE+'/api/oauth/start',{method:'POST',headers:{Origin:h.env.ALLOWED_ORIGIN,'Content-Type':'application/x-www-form-urlencoded'},body:'challenge='+await digest('e'.repeat(64))});assert.equal(r.status,503);assert.deepEqual(await h.storage.get('posts:sentinel'),{keep:true});}
});
test('handoff stays consumed if session persistence fails after proof succeeds',()=>withMock(async()=>{
 const h=await setup(),flow=await h.start(),handoff=await ticket(h,flow),before=(await h.storage.get(SESSION_KEY)).length;
 h.storage.fail=k=>k===SESSION_KEY;assert.equal((await h.complete(handoff,flow.verifier)).status,503);h.storage.fail=null;
 assert.equal((await h.complete(handoff,flow.verifier)).status,401);assert.equal((await h.storage.get(SESSION_KEY)).length,before);
}));
test('coerced handoff/verifier types rejected before any session is issued',()=>withMock(async()=>{
 const h=await setup(),flow=await h.start(),handoff=await ticket(h,flow);
 for(const [a,b] of [[[handoff],flow.verifier],[handoff,[flow.verifier]],[handoff,{value:flow.verifier}]])assert.equal((await h.complete(a,b)).status,400);
 assert.equal((await h.complete(handoff,flow.verifier)).status,200);
}));
test('OAuth fetch/body deadlines reject and consume the flow without blocking post state',async()=>{
 const nativeTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===5000?10:ms,...args);
 try{for(const bodyHang of [false,true])await withMock(async()=>{
 const h=await setup(),i=await h.issue(),flow=await h.start(),pending=callback(h,flow);
 assert.equal((await h.status(i)).status,200);assert.equal((await pending).status,503);assert.equal((await callback(h,flow)).status,401);assert.equal(h.writes,0);
 },()=>bodyHang?new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}}):new Promise(()=>{}));
 }finally{globalThis.setTimeout=nativeTimeout;}
});
test('callback/completion limits survive DO recreation and never relax posting authentication',async()=>{
 const h=await setup();await h.storage.put('auth:oauth2:callbacks',Array(120).fill(Date.now()));const flow=await h.start();h.restart();assert.equal((await callback(h,flow)).status,429);
 await h.storage.put('auth:oauth2:completions',Array(60).fill(Date.now()));assert.equal((await h.complete('e'.repeat(64),'e'.repeat(64))).status,429);
 assert.equal((await h.call('/api/forum/post-intents','POST',payload(),null,'invalid')).status,401);
});
