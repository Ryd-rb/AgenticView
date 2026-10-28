import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fixture, secrets } from './server-fixture.ts';

function raw(url: string, path: string, headers: Record<string,string> = {}, method='GET') {
  return new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:Buffer}>((done,fail)=>{
    const req=request(url,{path,method,headers},res=>{ const chunks:Buffer[]=[]; res.on('data',chunk=>chunks.push(chunk)); res.on('end',()=>done({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks)})); });
    req.setTimeout(5000,()=>req.destroy(new Error('HTTP asset deadline'))); req.on('error',fail); req.end();
  });
}

test('static representations negotiate, revalidate, invalidate and preserve route boundaries', async()=>{
  const web=mkdtempSync(join(tmpdir(),'agenticview-assets-'));
  mkdirSync(join(web,'assets'));
  const js='export const synthetic = "bounded synthetic module";\n'.repeat(1000);
  const asset='/assets/app-AbCd1234.js';
  writeFileSync(join(web,asset),js); writeFileSync(join(web,'index.html'),'<main>Synthetic shell</main>');
  writeFileSync(join(web,'style.css'),'body { color: inherit; }\n'.repeat(100));
  writeFileSync(join(web,'data.json'),'{"synthetic":true}');
  const oldRoot=process.env.AV_WEB_ROOT; process.env.AV_WEB_ROOT=web;
  const f=await fixture();
  if(oldRoot===undefined) delete process.env.AV_WEB_ROOT; else process.env.AV_WEB_ROOT=oldRoot;
  try {
    const identity=await raw(f.url,asset,{'Accept-Encoding':'identity'});
    assert.equal(identity.status,200); assert.equal(identity.body.toString(),js);
    assert.match(String(identity.headers['content-type']),/^text\/javascript/);
    assert.equal(identity.headers['cache-control'],'public,max-age=31536000,immutable');
    assert.match(String(identity.headers.etag),/^"[A-F0-9]{64}"$/);
    assert.equal(identity.headers['content-encoding'],undefined);
    for(const [encoding,decode] of [['br',brotliDecompressSync],['gzip',gunzipSync]] as const) {
      const encoded=await raw(f.url,asset,{'Accept-Encoding':encoding});
      assert.equal(encoded.headers['content-encoding'],encoding); assert.deepEqual(decode(encoded.body),identity.body);
      assert.ok(encoded.body.length<identity.body.length); assert.equal(encoded.headers.vary,'Accept-Encoding');
      assert.notEqual(encoded.headers.etag,identity.headers.etag);
      const head=await raw(f.url,asset,{'Accept-Encoding':encoding},'HEAD');
      assert.equal(head.status,200); assert.equal(head.body.length,0); assert.equal(head.headers.etag,encoded.headers.etag);
      assert.equal(Number(head.headers['content-length']),encoded.body.length);
      const cached=await raw(f.url,asset,{'Accept-Encoding':encoding,'If-None-Match':`"other", W/${encoded.headers.etag}`});
      assert.equal(cached.status,304); assert.equal(cached.body.length,0);
      assert.equal((await raw(f.url,asset,{'Accept-Encoding':'identity','If-None-Match':String(encoded.headers.etag)})).status,200);
    }
    assert.equal((await raw(f.url,asset,{'Accept-Encoding':'br;q=0, gzip;q=0.5, identity;q=0'})).headers['content-encoding'],'gzip');
    assert.equal((await raw(f.url,asset,{'Accept-Encoding':'*;q=0'})).status,406);
    assert.equal((await raw(f.url,asset,{'If-None-Match':'*'})).status,304);
    const index=await raw(f.url,'/'); assert.equal(index.headers['cache-control'],'no-cache'); assert.match(String(index.headers['content-type']),/^text\/html/);
    assert.equal((await raw(f.url,'/',{'If-None-Match':String(index.headers.etag)})).status,304);
    assert.match(String((await raw(f.url,'/style.css')).headers['content-type']),/^text\/css/);
    assert.match(String((await raw(f.url,'/data.json')).headers['content-type']),/^application\/json/);
    const changed=js+'// observed deployment change\n'; writeFileSync(join(web,asset),changed); const future=new Date(Date.now()+2000); utimesSync(join(web,asset),future,future);
    const stale=await raw(f.url,asset,{'Accept-Encoding':'identity','If-None-Match':String(identity.headers.etag)});
    assert.equal(stale.status,200); assert.equal(stale.body.toString(),changed); assert.notEqual(stale.headers.etag,identity.headers.etag);
    for(const path of ['/assets/../../credentials.json','/%2e%2e%5ccredentials.json','/C:%5cWindows%5cwin.ini','/api/missing']) {
      const response=await raw(f.url,path); assert.ok(response.status===400 || response.status===401 || response.status===404); assert.ok(!response.body.includes(Buffer.from(secrets.runSecret)));
    }
    assert.equal((await raw(f.url,'/api/snapshot',{'Accept-Encoding':'br'})).status,401);
    const api=await raw(f.url,'/api/snapshot',{Authorization:`Bearer ${secrets.viewerToken}`,'Accept-Encoding':'br'});
    assert.equal(api.status,200); assert.equal(api.headers['content-encoding'],undefined); assert.equal(api.headers.etag,undefined);
    await new Promise<void>((done,fail)=>{
      const req=request(f.url+'/api/events',{headers:{Authorization:`Bearer ${secrets.viewerToken}`,'Accept-Encoding':'br'}},res=>{
        try{assert.equal(res.headers['content-type'],'text/event-stream');assert.equal(res.headers['cache-control'],'no-store');assert.equal(res.headers['content-encoding'],undefined);assert.equal(res.headers.etag,undefined);}catch(error){req.destroy();fail(error);return;}
        res.once('data',chunk=>{try{assert.match(chunk.toString(),/event: snapshot/);req.destroy();done();}catch(error){fail(error);}});
      }); req.setTimeout(5000,()=>req.destroy(new Error('SSE flush deadline')));req.on('error',fail);req.end();
    });
  } finally {
    await f.close();
    if(dirname(resolve(web))!==resolve(tmpdir())||!basename(web).startsWith('agenticview-assets-')) throw new Error('Unsafe asset fixture cleanup');
    rmSync(web,{recursive:true});
  }
});
