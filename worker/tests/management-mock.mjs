// Test-only reads for legacy browser suites exercising the new management UI.
export function managementMock(url,opts={}){
  const u=new URL(url),p=u.pathname;
  if(opts.headers?.Authorization?.startsWith('Bot ')){
    if(p==='/api/v10/users/@me')return Response.json({id:'777',bot:true});
    if(/^\/api\/v10\/guilds\/456\/members\/(222|777)$/.test(p))return Response.json({user:{id:p.split('/').at(-1)},roles:[]});
    if(/^\/api\/v10\/channels\/123\/permissions\/member\/(222|777)$/.test(p))return Response.json({permissions:'68608'});
    if(p==='/api/v10/guilds/456/threads/active')return Response.json({threads:[],members:[]});
    if(p==='/api/v10/channels/123/threads/archived/public')return Response.json({threads:[],members:[],has_more:false});
  }
  return null;
}
