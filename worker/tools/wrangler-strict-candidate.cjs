// Validation-only adapter. Never changes the installed Wrangler or permits upload.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const ROOT=path.resolve(__dirname,'../..');
const ORIGINAL_SHA='31866b9a3686777254819158e60ebe4920d1d91141cde68846c62b52f75d7a66';
const ANCHOR='  const diff = diffJsonObjects(\n    normalizedRemoteConfig,\n    normalizedLocalConfig\n  );';
const INSERT=`  // Normalize only absent optional fields in comparison-only DO copies.
  for (const comparisonConfig of [normalizedRemoteConfig, normalizedLocalConfig]) {
    if (comparisonConfig.durable_objects?.bindings) {
      comparisonConfig.durable_objects = {
        ...comparisonConfig.durable_objects,
        bindings: comparisonConfig.durable_objects.bindings.map((binding) => {
          const normalizedBinding = { ...binding };
          for (const field of ["script_name", "environment"]) {
            if (normalizedBinding[field] === void 0) delete normalizedBinding[field];
          }
          return normalizedBinding;
        })
      };
    }
  }
`;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function original(){const file=require.resolve('wrangler');const bytes=fs.readFileSync(file);if(sha(bytes)!==ORIGINAL_SHA)throw new Error('CANDIDATE_BASE_MISMATCH');return {file,source:bytes.toString('utf8')};}
function patch(source){if(sha(source)!==ORIGINAL_SHA||source.split(ANCHOR).length!==2)throw new Error('CANDIDATE_BASE_MISMATCH');return source.replace(ANCHOR,INSERT+ANCHOR);}
function load(source,append=''){const {file}=original();const isolated=new Module(file,module);isolated.filename=file;isolated.paths=Module._nodeModulePaths(path.dirname(file));isolated._compile(source+'\n'+append,file);return isolated.exports;}
function validateArguments(args){
  if(args.length===1&&args[0]==='--version')return;
  if(args[0]!=='deploy')throw new Error('CANDIDATE_DRY_RUN_ONLY');
  const booleanFlags=new Set(['--dry-run','--strict','--keep-vars']),valueFlags=new Set(['--config','--outdir','--var']),seen=new Map();
  for(let i=1;i<args.length;i++){const flag=args[i];if(seen.has(flag))throw new Error('CANDIDATE_ARGUMENTS_REJECTED');if(booleanFlags.has(flag))seen.set(flag,true);else if(valueFlags.has(flag)&&typeof args[i+1]==='string'&&!args[i+1].startsWith('--'))seen.set(flag,args[++i]);else throw new Error('CANDIDATE_ARGUMENTS_REJECTED');}
  if([...booleanFlags].some(flag=>seen.get(flag)!==true)||seen.get('--var')!=='FORUM_POSTS_ENABLED:false')throw new Error('CANDIDATE_DRY_RUN_ONLY');
  if(path.resolve(ROOT,seen.get('--config')||'')!==path.join(ROOT,'worker/work/wrangler-strict-validation/wrangler.jsonc')||path.resolve(ROOT,seen.get('--outdir')||'')!==path.join(ROOT,'worker/work/wrangler-strict-validation/candidate-bundle'))throw new Error('CANDIDATE_PATH_REJECTED');
  const config=JSON.parse(fs.readFileSync(path.resolve(ROOT,seen.get('--config')),'utf8'));
  const expected={name:'discord-event-poster-api',main:'../../src/index.mjs',compatibility_date:'2026-04-01',secrets:{required:['ALLOWED_ORIGIN','DISCORD_BOT_TOKEN','DISCORD_FORUM_CHANNEL_ID','APP_PASSWORD_HASH','SESSION_SIGNING_KEY']},durable_objects:{bindings:[{name:'AUTH_STATE',class_name:'AuthState'}]},migrations:[{tag:'auth-v1',new_sqlite_classes:['AuthState']}],preview_urls:false,observability:{enabled:false}};
  if(JSON.stringify(config)!==JSON.stringify(expected))throw new Error('CANDIDATE_CONFIG_REJECTED');
}
async function run(args){
  validateArguments(args);
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV='false';process.env.WRANGLER_SEND_METRICS='false';process.env.CI='true';
  const {source}=original(),candidate=patch(source);
  console.error('Validation candidate: 4.149.0 + optional-DO-comparison normalization; upload disabled');
  const absoluteArgs=args.map((value,index)=>['--config','--outdir'].includes(args[index-1])?path.resolve(ROOT,value):value);
  const api=load(candidate,'exports.__candidateMain=main;');await api.__candidateMain(absoluteArgs);
}
module.exports={ROOT,ORIGINAL_SHA,ANCHOR,INSERT,sha,original,patch,load,validateArguments,run};
if(require.main===module)run(process.argv.slice(2)).catch(()=>{console.error('CANDIDATE_VALIDATION_FAILED_OR_COMMAND_REJECTED');process.exitCode=1;});
