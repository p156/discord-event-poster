const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const required=['index.html','app.js','poster-client.js','styles.css'];
const allowed=new Set([...required,'assets/css/style.css']);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function inspectSite(site,source){
  const files=[],seen=new Set();
  function walk(dir,prefix=''){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const name=prefix+entry.name,full=path.join(dir,entry.name),key=name.toLowerCase();
      if(seen.has(key))throw new Error('Case collision: '+name);seen.add(key);
      if(entry.isSymbolicLink())throw new Error('Link forbidden: '+name);
      if(entry.isDirectory()){
        if(!['assets','assets/css'].includes(name))throw new Error('Unexpected directory: '+name);
        walk(full,name+'/');
      }else{
        if(!entry.isFile()||!allowed.has(name))throw new Error('Unexpected file: '+name);
        const bytes=fs.readFileSync(full);files.push({name,bytes:bytes.length,sha256:sha(bytes)});
      }
    }
  }
  walk(site);
  for(const name of required){
    const actual=files.find(f=>f.name===name);
    if(!actual)throw new Error('Missing asset: '+name);
    if(actual.sha256!==sha(fs.readFileSync(path.join(source,name))))throw new Error('Source mismatch: '+name);
  }
  for(const name of ['app.js','poster-client.js'])new vm.Script(fs.readFileSync(path.join(site,name),'utf8'),{filename:name});
  const html=fs.readFileSync(path.join(site,'index.html'),'utf8'),base=new URL('https://pages.invalid/discord-event-poster/');
  const references=[...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)].map(m=>m[1]);
  for(const ref of references){
    const url=new URL(ref,base);
    if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))throw new Error('Asset escapes Pages path');
    const name=decodeURIComponent(url.pathname.slice(base.pathname.length));
    if(!files.some(f=>f.name===name))throw new Error('Unresolved asset reference');
  }
  return {fileCount:files.length,totalBytes:files.reduce((n,f)=>n+f.bytes,0),files:files.sort((a,b)=>a.name.localeCompare(b.name)),references};
}
module.exports={inspectSite};
if(require.main===module){
  try{
    if(!process.argv[2])throw new Error('Usage: node tests/pages-artifact-guard.cjs SITE_DIR [SOURCE_DIR]');
    console.log(JSON.stringify(inspectSite(path.resolve(process.argv[2]),path.resolve(process.argv[3]||path.join(__dirname,'..'))),null,2));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
