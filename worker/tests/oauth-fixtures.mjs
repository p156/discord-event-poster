import assert from 'node:assert/strict';
import {digest} from '../src/auth-session.mjs';
export {discordOAuthMock} from './oauth-mock.mjs';
export const BASE='https://discord-event-poster-api.monma5435.workers.dev';
export function oauthBindings(origin='https://poster.example'){
  return {ALLOWED_ORIGIN:origin,DISCORD_OAUTH_CLIENT_ID:'111',DISCORD_OAUTH_CLIENT_SECRET:'TEST_ONLY_OAUTH_SECRET',DISCORD_ALLOWED_USER_ID:'222',AUTH_SESSION_SIGNING_KEY:'d'.repeat(64),DISCORD_OAUTH_REDIRECT_URI:BASE+'/api/oauth/callback'};
}
export async function startFlow(dispatch,origin='https://poster.example',verifier='e'.repeat(64)){
  const r=await dispatch(BASE+'/api/oauth/start',{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({challenge:await digest(verifier)}).toString()});
  assert.equal(r.status,303);const state=new URL(r.headers.get('Location')).searchParams.get('state'),cookie=r.headers.get('Set-Cookie').split(';')[0];
  return {state,cookie,verifier};
}
export async function finishFlow(dispatch,flow,origin='https://poster.example',code='TEST_ONLY_CODE'){
  const r=await dispatch(BASE+'/api/oauth/callback?'+new URLSearchParams({state:flow.state,code,iss:'https://discord.com'}),{headers:{Cookie:flow.cookie}});
  const html=await r.text();assert.equal(r.status,200,html);const handoff=html.match(/"handoff":"([a-f0-9]{64})"/)?.[1];assert.ok(handoff);
  const complete=await dispatch(BASE+'/api/oauth/complete',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({handoff,verifier:flow.verifier})});
  assert.equal(complete.status,200);return complete.json();
}
export async function mockLogin(dispatch,origin='https://poster.example'){return finishFlow(dispatch,await startFlow(dispatch,origin),origin);}
