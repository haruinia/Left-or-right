import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../desktop/main/sign-mac.js',import.meta.url),'utf8');
function fixture({verifyFails=false}={}){
 const calls=[];
 const context={module:{exports:{}},require:name=>name==='node:child_process'?{execFileSync(command,args){calls.push([command,[...args]]);if(verifyFails&&args.includes('--verify'))throw Error('Signature verification failed');}}:{signAsync:async options=>calls.push(['developer-sign',options.identity])}};
 vm.runInNewContext(source,context);return {sign:context.module.exports,calls};
}

test('local Mac builds create a complete ad-hoc signature and verify it without granting permissions',async()=>{
 const f=fixture();await f.sign({app:'/build/左右.app'});
 assert.deepEqual(f.calls,[['/usr/bin/codesign',['--force','--deep','--sign','-','--timestamp=none','/build/左右.app']],['/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2','/build/左右.app']]]);
 assert.doesNotMatch(source,/tccutil|TCC\.db|csreq|security add|allow.*capture/i);
});

test('an explicitly configured developer signing identity is retained',async()=>{
 const f=fixture();await f.sign({app:'/build/左右.app',identity:'Developer ID configured by user'});
 assert.deepEqual(f.calls[0],['developer-sign','Developer ID configured by user']);
 assert.ok(f.calls[1][1].includes('--verify'));
});

test('invalid signatures fail the build rather than shipping a broken permission identity',async()=>{
 const f=fixture({verifyFails:true});await assert.rejects(f.sign({app:'/build/左右.app'}),/Signature verification failed/);
 const config=JSON.parse(fs.readFileSync(new URL('../desktop/package.json',import.meta.url),'utf8'));
 assert.equal(config.build.mac.sign,'main/sign-mac.js');
});
