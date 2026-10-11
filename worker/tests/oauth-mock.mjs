// Test-only strict transport. No network fallback, including for unknown destinations.
export function discordOAuthMock(url,opts={}){
  if(String(url)==='https://discord.com/api/oauth2/token'){
    const form=new URLSearchParams(opts.body);
    if(form.get('grant_type')!=='authorization_code'||form.get('client_secret')!=='TEST_ONLY_OAUTH_SECRET'||opts.redirect!=='manual')throw new Error('INVALID_TEST_OAUTH_EXCHANGE');
    return Response.json({access_token:'TEST_ONLY_OAUTH_TOKEN',token_type:'Bearer',scope:'identify',expires_in:600,refresh_token:'TEST_ONLY_REFRESH'});
  }
  if(String(url)==='https://discord.com/api/v10/users/@me'){
    if(opts.headers.Authorization!=='Bearer TEST_ONLY_OAUTH_TOKEN'||opts.redirect!=='manual')throw new Error('INVALID_TEST_OAUTH_IDENTITY');
    return Response.json({id:'222'});
  }
  throw new Error('REAL_NETWORK_DISABLED');
}
