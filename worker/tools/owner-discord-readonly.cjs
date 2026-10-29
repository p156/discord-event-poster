'use strict';
const EXPECTED=Object.freeze({botId:'1319011620185309265',guildId:'1282386566450380871',forumId:'1554204439521398794'});
const stop=()=>{throw Error('OWNER_DISCORD_STOPPED');};
async function collect(token,fetchImpl=globalThis.fetch){
 const {readBotSelf,readFixedForum}=await import('../src/discord-client.mjs');
 const env={DISCORD_BOT_TOKEN:token,DISCORD_FORUM_CHANNEL_ID:EXPECTED.forumId};
 const self=await readBotSelf(env,{fetchImpl});
 if(self.status!==200||self.body?.bot!==true||self.body.id!==EXPECTED.botId)stop();
 const forum=await readFixedForum(env,{fetchImpl});
 if(forum.status!==200||forum.body?.id!==EXPECTED.forumId||forum.body.guild_id!==EXPECTED.guildId||forum.body.type!==15)stop();
 return {schema:1,status:'PASS',scope:'local-input-token-fixed-forum-only',...EXPECTED,forumType:15,
  localTokenBotIdentity:'PASS',localTokenForumAccess:'PASS',workerTokenIdentity:'NOT VERIFIED',workerForumIdentity:'NOT VERIFIED',
  botForum:'NOT VERIFIED',effectivePermissions:'NOT VERIFIED',applicationEndpoint:'NOT CHECKED',
  releaseEligible:false,productionGo:false,cloudWrites:0,discordWrites:0};
}
async function run(stream,fetcher=globalThis.fetch,args=process.argv){
 let credentials;const chunks=[];let bytes;
 try{
  if(args.length!==2||stream.isTTY)stop();
  let size=0;for await(const chunk of stream){chunks.push(chunk);size+=chunk.length;if(size>8192)stop();}
  bytes=Buffer.concat(chunks);credentials=JSON.parse(bytes.toString('utf8'));
  if(!credentials||Object.keys(credentials).join()!=='token')stop();
  return {result:await collect(credentials.token,fetcher)};
 }catch{return {diagnostic:'OWNER_DISCORD_STOPPED'};}
 finally{bytes?.fill(0);for(const chunk of chunks)chunk.fill(0);if(credentials)credentials.token=null;}
}
module.exports={EXPECTED,collect,run};
if(require.main===module)run(process.stdin).then(({result,diagnostic})=>{
 if(diagnostic){console.error(diagnostic);process.exitCode=1;}else console.log(JSON.stringify(result));
});
