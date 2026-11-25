import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { settingsRoute as parseRoute } from '../web/modules/settings-navigation.js';

const secretIds={api_key:['asrApiKey','asrToggleKey'],app_id:['asrAppId','asrToggleAppId'],app_key:['asrAppKey','asrToggleAppKey'],nls_token:['asrNlsToken','asrToggleNlsToken'],access_key_id:['asrAccessKeyId','asrToggleAccessKeyId'],access_key_secret:['asrAccessKeySecret','asrToggleAccessKeySecret']};
function fixture(provider='aliyun_ws') {
  const ids=['asrForm','asrName','asrEndpoint','asrProvider','asrAuthMode','asrAuthModeLabel','asrModel','asrModelLabel','asrLanguageHints','asrLanguageHintsLabel','asrVocabulary','asrVocabularyLabel','asrFormTitle','asrCheck','asrProfileCards','asrProfileState','asrNew','asrCancel','asrRefresh','asrSave'];
  for(const [input,toggle] of Object.values(secretIds))ids.push(input,toggle,input+'Label',input+'Field');
  const node=()=>({value:'',textContent:'',type:'password',disabled:false,hidden:false,children:[],attributes:{},dataset:{},listeners:{},addEventListener(event,callback){this.listeners[event]=callback;},setAttribute(name,value){this.attributes[name]=value;},replaceChildren(...children){this.children=children;},append(...children){this.children.push(...children);},focus(){},select(){}});
  const elements=new Map(ids.map(id=>['#'+id,node()]));
  const selected={id:'primary',name:'语音服务',provider,endpoint:provider==='aliyun_ws'?'wss://asr.example.test/inference':provider==='xfyun_rtasr'?'wss://rtasr.xfyun.cn/v1/ws':'wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1',model:provider==='aliyun_ws'?'asr-model':'',auth_mode:'token',language_hints:'zh,en',vocabulary_id:'',api_key_configured:provider!=='aliyun_nls_ws',app_id_configured:provider==='xfyun_rtasr',app_key_configured:provider==='aliyun_nls_ws',nls_token_configured:provider==='aliyun_nls_ws',access_key_id_configured:false,access_key_secret_configured:false,configured:true};
  const store={active_profile_id:'primary',profiles:[selected]},calls=[],events=[],listeners={};
  let context;
  const sandbox={document:{querySelector:selector=>elements.get(selector),createElement:()=>node()},structuredClone,settingsRoute:()=>parseRoute(sandbox.location.hash),navigateSettings:value=>{sandbox.location.hash=value;vm.runInContext('syncEditorRoute()',context);},returnToConnections:()=>{sandbox.location.hash='#models/asr';vm.runInContext('syncEditorRoute()',context);},confirmSettingsAction:async()=>true,location:{hash:'#models'},Event:class{constructor(type){this.type=type;}},window:{addEventListener(name,fn){listeners[name]=fn;},dispatchEvent(event){events.push(event.type);}},asrRequest:async(path,options={})=>{
    calls.push({path,...options});
    if(path.endsWith('/key'))return {api_key:'test-only-saved-key'};
    if(path.includes('/secrets/'))return {value:'test-saved-'+path.split('/').at(-1)};
    if(path.endsWith('/check'))return {ok:true,detail:'连接验证通过；未进行语音识别。'};
    if(options.method==='POST'&&path.endsWith('/profiles')){
      const value=options.body,index=store.profiles.findIndex(item=>item.id===value.id);
      const profile={...(index>=0?store.profiles[index]:{}),...value,id:value.id||'created',configured:true};
      for(const field of Object.keys(secretIds)){if(Object.hasOwn(value,field))profile[field+'_configured']=Boolean(value[field]);delete profile[field];}
      if(index>=0)store.profiles[index]=profile;else store.profiles.push(profile);store.active_profile_id=profile.id;
    }
    return structuredClone(store);
  }};
  context=vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL('../web/modules/asr-config.js',import.meta.url),'utf8').replace(/^import .*;$/gm,''),context);
  const run=expression=>vm.runInContext(expression,context);
  const input=(id,value)=>{elements.get('#'+id).value=value;elements.get('#'+id).listeners.input?.();elements.get('#asrForm').listeners.input();};
  const change=(id,value)=>{elements.get('#'+id).value=value;elements.get('#'+id).listeners.change?.();};
  const open=async(id='primary')=>{sandbox.location.hash='#models/asr/'+id;await run('load()');};
  return {elements,store,calls,events,listeners,sandbox,run,input,change,open};
}

const save=f=>f.run('save({preventDefault(){}})');
const saved=f=>f.calls.find(call=>call.method==='POST'&&call.path.endsWith('/profiles'));

test('ASR config loads only when opened and retains the existing DashScope mask contract',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.open();
  assert.equal(f.elements.get('#asrApiKey').value,'************');assert.equal(f.elements.get('#asrApiKey').type,'password');
  assert.equal(f.elements.get('#asrProvider').value,'aliyun_ws');assert.equal(f.elements.get('#asrProvider').disabled,true);
  await f.run('reveal()');assert.equal(f.elements.get('#asrApiKey').value,'test-only-saved-key');assert.equal(f.elements.get('#asrApiKey').type,'text');
  assert.equal(f.calls.at(-1).path,'/api/config/asr/profiles/primary/key');await f.run('reveal()');assert.equal(f.elements.get('#asrApiKey').type,'password');
});

test('saving untouched and revealed DashScope keys omits credential fields',async()=>{
  const f=fixture();await f.open();await save(f);assert.equal(Object.hasOwn(saved(f).body,'api_key'),false);
  await f.run('reveal()');f.calls.length=0;f.input('asrName','新的名称');await save(f);
  assert.equal(saved(f).body.id,'primary');assert.equal(saved(f).body.name,'新的名称');assert.equal(Object.hasOwn(saved(f).body,'api_key'),false);assert.ok(f.events.includes('asr:profiles-changed'));
});

test('only explicitly replaced DashScope credentials are sent and empty replacement is rejected',async()=>{
  const f=fixture();await f.open();f.input('asrApiKey','new-test-key');await save(f);assert.equal(saved(f).body.api_key,'new-test-key');
  f.calls.length=0;f.input('asrApiKey','');await save(f);assert.equal(f.calls.length,0);assert.match(f.elements.get('#asrProfileState').textContent,/请填写 API Key/);
});

test('late secret reveal cannot overwrite another profile or typed replacement',async()=>{
  const f=fixture();await f.open();let release;f.sandbox.asrRequest=()=>new Promise(resolve=>{release=resolve;});
  const pending=f.run('reveal()');f.input('asrApiKey','replacement');release({api_key:'stale-key'});await pending;
  assert.equal(f.elements.get('#asrApiKey').value,'replacement');assert.equal(f.elements.get('#asrToggleKey').disabled,false);
});

test('connection check is clearly not recognition and does not check a dirty draft',async()=>{
  const f=fixture();await f.open();await f.elements.get('#asrCheck').listeners.click();assert.match(f.elements.get('#asrProfileState').textContent,/未进行语音识别/);
  f.calls.length=0;f.input('asrName','草稿');await f.elements.get('#asrCheck').listeners.click();assert.equal(f.calls.length,0);
});

test('refresh retains an edited form instead of replacing it with server values',async()=>{
  const f=fixture();await f.open();f.input('asrName','未保存名称');await f.open();assert.equal(f.elements.get('#asrName').value,'未保存名称');
});

test('new connections default to NLS temporary-token mode without a model field',async()=>{
  const f=fixture();await f.open('new');
  assert.equal(f.elements.get('#asrProvider').value,'aliyun_nls_ws');assert.equal(f.elements.get('#asrProvider').disabled,false);
  assert.equal(f.elements.get('#asrAuthMode').value,'token');assert.equal(f.elements.get('#asrNlsTokenField').hidden,false);assert.equal(f.elements.get('#asrAppKeyField').hidden,false);
  assert.equal(f.elements.get('#asrApiKeyField').hidden,true);assert.equal(f.elements.get('#asrModelLabel').hidden,true);assert.equal(f.elements.get('#asrModel').required,false);
  assert.equal(f.elements.get('#asrModel').disabled,true);assert.match(f.elements.get('#asrEndpoint').value,/nls-gateway/);
  f.input('asrName','个人 NLS');f.input('asrAppKey','app-test');f.input('asrNlsToken','token-test');await save(f);
  assert.deepEqual(JSON.parse(JSON.stringify(saved(f).body)),{name:'个人 NLS',provider:'aliyun_nls_ws',endpoint:'wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1',vocabulary_id:'',auth_mode:'token',app_key:'app-test',nls_token:'token-test'});
});

test('typing a new NLS draft before the first profile load cannot be overwritten by its late response',async()=>{
  const f=fixture();let resolve;
  f.sandbox.asrRequest=()=>new Promise(done=>{resolve=done;});
  f.sandbox.location.hash='#models/asr/new';const pending=f.run('load()');f.run('syncEditorRoute()');
  f.input('asrName','提前填写的 NLS');f.input('asrAppKey','new-app');f.input('asrNlsToken','new-token');
  resolve(structuredClone(f.store));await pending;
  assert.equal(f.elements.get('#asrProvider').value,'aliyun_nls_ws');
  assert.equal(f.elements.get('#asrName').value,'提前填写的 NLS');
  assert.equal(f.elements.get('#asrAppKey').value,'new-app');assert.equal(f.elements.get('#asrNlsToken').value,'new-token');
});

test('NLS saved secrets are independently masked, revealed and omitted when unchanged',async()=>{
  const f=fixture('aliyun_nls_ws');await f.open();
  assert.equal(f.elements.get('#asrAppKey').value,'************');assert.equal(f.elements.get('#asrNlsToken').value,'************');
  await f.run("reveal('app_key')");assert.equal(f.elements.get('#asrAppKey').value,'test-saved-app_key');assert.equal(f.elements.get('#asrNlsToken').value,'************');
  assert.equal(f.calls.at(-1).path,'/api/config/asr/profiles/primary/secrets/app_key');
  await f.run("reveal('nls_token')");assert.equal(f.elements.get('#asrNlsToken').value,'test-saved-nls_token');
  f.calls.length=0;await save(f);
  assert.equal(saved(f).body.provider,'aliyun_nls_ws');for(const field of Object.keys(secretIds))assert.equal(Object.hasOwn(saved(f).body,field),false);
  assert.ok(JSON.stringify(f.elements.get('#asrProfileCards').children).includes('阿里云 NLS'));
  assert.ok(!JSON.stringify(f.elements.get('#asrProfileCards').children).includes('test-saved'));
});

test('automatic token mode sends only the relevant newly supplied AccessKey credentials',async()=>{
  const f=fixture('aliyun_nls_ws');await f.open();f.change('asrAuthMode','access_key');
  assert.equal(f.elements.get('#asrNlsTokenField').hidden,true);assert.equal(f.elements.get('#asrAccessKeyIdField').hidden,false);assert.equal(f.elements.get('#asrAccessKeySecretField').hidden,false);
  f.calls.length=0;await save(f);assert.equal(f.calls.length,0);assert.match(f.elements.get('#asrProfileState').textContent,/AccessKey ID/);
  f.input('asrAccessKeyId','test-id');f.input('asrAccessKeySecret','test-secret');await save(f);
  assert.equal(saved(f).body.auth_mode,'access_key');assert.equal(saved(f).body.access_key_id,'test-id');assert.equal(saved(f).body.access_key_secret,'test-secret');
  assert.equal(Object.hasOwn(saved(f).body,'app_key'),false);assert.equal(Object.hasOwn(saved(f).body,'nls_token'),false);assert.equal(Object.hasOwn(saved(f).body,'api_key'),false);
});

test('existing providers cannot be changed by editing their select state',async()=>{
  const f=fixture();await f.open();f.change('asrProvider','aliyun_nls_ws');assert.equal(f.elements.get('#asrProvider').value,'aliyun_ws');
});

test('new provider changes clear credentials and switch the protocol-specific defaults',async()=>{
  const f=fixture();await f.open('new');f.input('asrAppKey','not-for-bailian');f.input('asrNlsToken','private-token');f.change('asrProvider','aliyun_ws');
  assert.equal(f.elements.get('#asrAppKey').value,'');assert.equal(f.elements.get('#asrNlsToken').value,'');assert.equal(f.elements.get('#asrApiKey').value,'');
  assert.match(f.elements.get('#asrEndpoint').value,/dashscope/);assert.equal(f.elements.get('#asrModelLabel').hidden,false);assert.equal(f.elements.get('#asrModel').required,true);
});

test('XFYUN fields save defaults and reveal private APPID through local secret API',async()=>{
  const f=fixture('xfyun_rtasr');await f.open();
  assert.equal(f.elements.get('#asrAppId').value,'************');assert.equal(f.elements.get('#asrApiKey').value,'************');
  assert.equal(f.elements.get('#asrAppKeyField').hidden,true);assert.equal(f.elements.get('#asrAuthMode').hidden,true);
  assert.equal(f.elements.get('#asrModelLabel').hidden,true);assert.equal(f.elements.get('#asrLanguageHintsLabel').hidden,true);
  assert.equal(f.elements.get('#asrVocabularyLabel').hidden,true);assert.equal(f.elements.get('#asrVocabulary').disabled,true);
  await f.run("reveal('app_id')");assert.equal(f.elements.get('#asrAppId').value,'test-saved-app_id');
  assert.equal(f.calls.at(-1).path,'/api/config/asr/profiles/primary/secrets/app_id');
  f.input('asrAppId','replacement-app');await save(f);
  assert.deepEqual(JSON.parse(JSON.stringify(saved(f).body)),{id:'primary',name:'语音服务',provider:'xfyun_rtasr',endpoint:'wss://rtasr.xfyun.cn/v1/ws',vocabulary_id:'',app_id:'replacement-app'});
  assert.ok(JSON.stringify(f.elements.get('#asrProfileCards').children).includes('讯飞实时转写'));
  assert.ok(!JSON.stringify(f.elements.get('#asrProfileCards').children).includes('replacement-app'));
});

test('switching to XFYUN clears NLS secrets and requires both new credentials',async()=>{
  const f=fixture();await f.open('new');f.input('asrAppKey','private-nls');f.input('asrNlsToken','private-token');
  f.change('asrProvider','xfyun_rtasr');f.input('asrName','讯飞测试');
  assert.equal(f.elements.get('#asrAppKey').value,'');assert.equal(f.elements.get('#asrNlsToken').value,'');
  assert.match(f.elements.get('#asrEndpoint').value,/rtasr\.xfyun\.cn/);
  await save(f);assert.equal(f.calls.length,1);assert.match(f.elements.get('#asrProfileState').textContent,/APPID/);
  f.input('asrAppId','test-app');await save(f);assert.match(f.elements.get('#asrProfileState').textContent,/API Key/);
  f.input('asrApiKey','test-key');await save(f);
  assert.equal(saved(f).body.provider,'xfyun_rtasr');assert.equal(saved(f).body.app_id,'test-app');assert.equal(saved(f).body.api_key,'test-key');
  assert.equal(Object.hasOwn(saved(f).body,'model'),false);assert.equal(Object.hasOwn(saved(f).body,'auth_mode'),false);
});

test('privacy hide and navigation mask all saved secrets and invalidate their pending reveals',async()=>{
  const f=fixture('aliyun_nls_ws');await f.open();await f.run("reveal('app_key')");let release;
  f.sandbox.asrRequest=()=>new Promise(resolve=>{release=resolve;});const pending=f.run("reveal('nls_token')");
  f.listeners['app:privacy-hidden']();release({value:'late-token'});await pending;
  assert.equal(f.elements.get('#asrAppKey').value,'************');assert.equal(f.elements.get('#asrNlsToken').value,'************');
  assert.equal(f.elements.get('#asrAppKey').type,'password');assert.equal(f.elements.get('#asrToggleNlsToken').disabled,false);
});

test('replacement NLS drafts survive navigation while saved revealed values are not retained',async()=>{
  const f=fixture('aliyun_nls_ws');await f.open();await f.run("reveal('app_key')");f.input('asrNlsToken','replacement-token');
  f.sandbox.location.hash='#briefing';f.run('syncEditorRoute()');assert.equal(f.elements.get('#asrAppKey').value,'************');
  f.sandbox.location.hash='#models/asr/primary';f.run('syncEditorRoute()');assert.equal(f.elements.get('#asrNlsToken').value,'replacement-token');assert.equal(f.elements.get('#asrAppKey').value,'************');
});

test('failed NLS saves keep editor values and cancellation discards the draft',async()=>{
  const f=fixture('aliyun_nls_ws');await f.open();f.input('asrName','未保存 NLS');f.input('asrNlsToken','new-token');f.sandbox.asrRequest=async()=>{throw Error('network unavailable');};await save(f);
  assert.equal(f.sandbox.location.hash,'#models/asr/primary');assert.equal(f.elements.get('#asrName').value,'未保存 NLS');assert.equal(f.elements.get('#asrNlsToken').value,'new-token');assert.match(f.elements.get('#asrProfileState').textContent,/保存失败/);
  f.elements.get('#asrCancel').listeners.click();assert.equal(f.sandbox.location.hash,'#models/asr');
});
