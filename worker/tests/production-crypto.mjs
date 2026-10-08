// Explicitly emulate the reported production restriction, NOT CPU/other platform limits.
// Local Node/workerd alone do not enforce this production Web Crypto policy.
export function installProductionPbkdf2Limit() {
  const subtle=crypto.subtle;
  const originals=new Map();
  let forbiddenCalls=0;
  for(const method of ['deriveBits','deriveKey']){
    originals.set(method,subtle[method]);
    subtle[method]=function(algorithm,...args){
      const name=typeof algorithm==='string'?algorithm:algorithm?.name;
      if(name?.toUpperCase()==='PBKDF2'&&algorithm.iterations>100000){
        forbiddenCalls++;
        return Promise.reject(new DOMException('Pbkdf2 failed: iteration counts above 100000 are not supported (requested '+algorithm.iterations+').','NotSupportedError'));
      }
      return originals.get(method).call(subtle,algorithm,...args);
    };
  }
  return {get forbiddenCalls(){return forbiddenCalls;},restore(){for(const [method,original]of originals)subtle[method]=original;}};
}
