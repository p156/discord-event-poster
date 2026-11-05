const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {inspectSite}=require('./pages-artifact-guard.cjs');
function fixture(t,html='<link href="styles.css?v=1"><script src="poster-client.js"></script><script src="app.js"></script>'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pages-guard-'));t.after(()=>{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.match(path.basename(root),/^pages-guard-/);
    fs.rmSync(root,{recursive:true,force:true});
  });
  const source=path.join(root,'source'),site=path.join(root,'site');fs.mkdirSync(source);fs.mkdirSync(site);
  for(const [name,text]of Object.entries({'index.html':html,'app.js':'void 0;','poster-client.js':'void 0;','styles.css':'body{}'})){
    fs.writeFileSync(path.join(source,name),text);fs.writeFileSync(path.join(site,name),text);
  }
  return {source,site};
}
test('accepts copied application assets and optional Jekyll theme CSS',t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.site,'assets/css'),{recursive:true});fs.writeFileSync(path.join(f.site,'assets/css/style.css'),'body{}');
  assert.equal(inspectSite(f.site,f.source).fileCount,5);
});
for(const name of ['README.md','ACCEPTANCE.md','ACCEPTANCE.html','package.json','.env'])test('rejects unintended publication: '+name,t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.site,name),'test');assert.throws(()=>inspectSite(f.site,f.source),/Unexpected file/);
});
test('rejects Worker directory even when empty',t=>{const f=fixture(t);fs.mkdirSync(path.join(f.site,'worker'));assert.throws(()=>inspectSite(f.site,f.source),/Unexpected directory/);});
test('rejects missing and stale assets',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.site,'app.js'),'void 1;');assert.throws(()=>inspectSite(f.site,f.source),/Source mismatch/);
  fs.unlinkSync(path.join(f.site,'app.js'));assert.throws(()=>inspectSite(f.site,f.source),/Missing asset/);
});
test('rejects asset paths outside repository subpath',t=>{const f=fixture(t,'<script src="/app.js"></script>');assert.throws(()=>inspectSite(f.site,f.source),/escapes Pages path/);});
test('rejects unresolved references',t=>{const f=fixture(t,'<script src="missing.js"></script>');assert.throws(()=>inspectSite(f.site,f.source),/Unresolved/);});
