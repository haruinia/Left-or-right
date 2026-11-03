import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const quickSource=fs.readFileSync(new URL('../web/modules/quick-settings.js',import.meta.url),'utf8');
const homeSource=fs.readFileSync(new URL('../web/modules/home.js',import.meta.url),'utf8');
const studySource=fs.readFileSync(new URL('../web/modules/study-presets.js',import.meta.url),'utf8');

class Element {
  constructor(tag='div') { this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.value='';this.disabled=false;this.textContent='';this.style={}; }
  get options() { return this.children.flatMap(child=>child.tagName==='OPTGROUP'?child.options:[child]); }
  focus() {}
  addEventListener(type,callback) { this.listeners[type]=callback; }
  replaceChildren(...children) { this.children=[...children]; }
  append(...children) { this.children.push(...children); }
  querySelector() { return new Element(); }
}
class Option extends Element {
  constructor(text,value) { super('option');this.textContent=text;this.value=value; }
}
function quickModule() {
  const elements=new Map();
  const byId=id=>{if(!elements.has(id))elements.set(id,new Element(['quickDisplay','quickModel'].includes(id)?'select':'div'));return elements.get(id);};
  const calls=[];
  const requests=[];
  const backend={mode:'area',displayId:'1',displays:[{id:1,label:'内建屏',width:1512,height:982},{id:2,label:'外接屏',width:1920,height:1080}]};
  const prefs={study_specialty:'计算机 / 软件工程',study_language:'Go',answer_language:'zh-CN',assistant_role:'candidate'};
  const models={active_profile_id:'personal',profiles:[
    {id:'personal',name:'个人接口',llm_model:'same-model',llm_base_url:'https://personal.example.test/v1'},
    {id:'team',name:'团队接口',llm_model:'same-model',llm_base_url:'https://team.example.test/v1'},
  ]};
  const sandbox={
    document:{getElementById:byId,querySelector:()=>null,createElement:tag=>new Element(tag),addEventListener(){}},
    window:{addEventListener(){},location:{origin:'http://localhost'},cockpit:{
      setCaptureOptions:async patch=>{calls.push(patch);Object.assign(backend,patch);return {...backend,saved:true};},
      getConfig:async()=>({captureOptions:backend}),
    }},
    state:{},applyDisplay(){},ResizeObserver:class{observe(){}},Option,URL,AbortSignal,innerHeight:720,
    fetch:async(url,options)=>{
      const path=new URL(url).pathname;
      const body=options.body?JSON.parse(options.body):undefined;
      requests.push({path,method:options.method,body});
      if(path==='/api/config/llm/activate')models.active_profile_id=body.profile_id;
      if(path==='/api/ui/settings') {
        if(body)Object.assign(prefs,body);
        return {ok:true,json:async()=>prefs};
      }
      return {ok:true,json:async()=>models};
    },
  };
  const context=vm.createContext(sandbox);
  vm.runInContext(studySource.replace(/^export /gm,'')+'\n'+quickSource.replace(/^import .*;$/gm,'').replaceAll('export async function','async function'),context);
  sandbox.config={captureOptions:backend};
  vm.runInContext('hydrateCapture(config)',context);
  sandbox.prefs=prefs;
  return {elements,byId,calls,requests,backend,models,prefs,sandbox,run:code=>vm.runInContext(code,context)};
}

test('running displays use one ordinary select with the effective backend choice',()=>{
  const {byId}=quickModule();
  const select=byId('quickDisplay');
  assert.equal(select.tagName,'SELECT');
  assert.deepEqual(select.options.map(option=>option.value),['1','2']);
  assert.equal(select.value,'1');
  assert.equal(select.disabled,false);
});

test('choosing another running display sends only one string displayId',async()=>{
  const {byId,calls}=quickModule();
  const select=byId('quickDisplay');select.value='2';
  await select.listeners.change();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{displayId:'2'}]);
  assert.equal(select.value,'2');
  assert.equal(select.disabled,false);
  assert.equal(byId('quickSettingsStatus').textContent,'已保存。');
});

test('an empty running display does not send an invalid selection',async()=>{
  const {byId,calls}=quickModule();
  const select=byId('quickDisplay');select.value='';
  await select.listeners.change();
  assert.equal(calls.length,0);
});

test('effective backend selection replaces disconnected display options',async()=>{
  const {byId,backend,sandbox}=quickModule();
  sandbox.window.cockpit.setCaptureOptions=async()=>({mode:'full',displayId:'2',displays:[backend.displays[1]],saved:true});
  const select=byId('quickDisplay');select.value='2';
  await select.listeners.change();
  assert.deepEqual(select.options.map(option=>option.value),['2']);
  assert.equal(select.value,'2');
  assert.equal(byId('quickCaptureMode').value,'full');
});

test('failed display moves restore the effective selection returned by the app',async()=>{
  const {byId,sandbox,calls}=quickModule();
  sandbox.window.cockpit.setCaptureOptions=async()=>{throw Error('显示器已断开');};
  const select=byId('quickDisplay');select.value='2';
  await select.listeners.change();
  assert.equal(calls.length,0);
  assert.equal(select.value,'1');
  assert.match(byId('quickSettingsStatus').textContent,/显示器已断开/);
  assert.equal(select.disabled,false);
});

test('display names are literal option text and browser-only capture remains disabled',()=>{
  const {byId,backend,run}=quickModule();backend.displays[0].label='<img src=x onerror=alert(1)>';
  run('hydrateCapture(config)');
  assert.match(byId('quickDisplay').options[0].textContent,/^<img src=x onerror=alert\(1\)>/);
  run('hydrateCapture({})');
  assert.equal(byId('quickDisplay').disabled,true);
  assert.equal(byId('quickCaptureMode').disabled,true);
});

test('saved Go does not filter the complete language and grouped specialty choices',()=>{
  const {run,byId}=quickModule();
  run('hydrateUi(prefs)');
  const languages=byId('quickProgrammingLanguage').options.map(option=>option.value);
  for(const value of ['', 'Go', 'Python', 'Java', 'PHP', 'MATLAB', 'Solidity', 'SystemVerilog'])assert.ok(languages.includes(value),value);
  assert.equal(byId('quickProgrammingLanguage').value,'Go');
  const specialty=byId('quickSpecialty');
  assert.ok(specialty.options.some(option=>option.value==='行测'));
  assert.ok(specialty.options.some(option=>option.value==='申论'));
  assert.ok(specialty.children.some(group=>group.label==='考试与资格'));
});

test('exam choice patches only specialty and disables but retains the prior code language',async()=>{
  const {run,byId,requests}=quickModule();
  run('hydrateUi(prefs)');
  byId('quickSpecialty').value='行测';
  await byId('quickSpecialty').listeners.change();
  assert.deepEqual(requests.at(-1).body,{study_specialty:'行测'});
  assert.equal(byId('quickProgrammingLanguage').disabled,true);
  assert.equal(byId('quickProgrammingLanguage').value,'Go');
  byId('quickSpecialty').value='后端开发';
  await byId('quickSpecialty').listeners.change();
  assert.equal(byId('quickProgrammingLanguage').disabled,false);
  assert.equal(byId('quickProgrammingLanguage').value,'Go');
});

test('custom option does not send its internal marker and saves the entered value',async()=>{
  const {run,byId,requests}=quickModule();
  run('hydrateUi(prefs)');
  byId('quickProgrammingLanguage').value='__custom__';
  await byId('quickProgrammingLanguage').listeners.change();
  assert.equal(requests.length,0);
  assert.equal(byId('quickProgrammingLanguageCustom').hidden,false);
  byId('quickProgrammingLanguageCustom').value='OCaml';
  await byId('quickProgrammingLanguageCustom').listeners.change();
  assert.deepEqual(requests[0].body,{study_language:'OCaml'});
  assert.equal(byId('quickProgrammingLanguage').value,'OCaml');
  assert.equal(byId('quickProgrammingLanguageCustom').hidden,true);
});

test('empty custom input is not saved, and unknown saved choices are not lost',async()=>{
  const {run,byId,requests,prefs}=quickModule();
  prefs.study_language='OCaml';prefs.study_specialty='物流管理';
  run('hydrateUi(prefs)');
  assert.equal(byId('quickProgrammingLanguage').value,'OCaml');
  assert.equal(byId('quickSpecialty').value,'物流管理');
  byId('quickSpecialty').value='__custom__';
  await byId('quickSpecialty').listeners.change();
  byId('quickSpecialtyCustom').value='';
  await byId('quickSpecialtyCustom').listeners.change();
  assert.equal(requests.length,0);
  assert.match(byId('quickSettingsStatus').textContent,/填写/);
});

test('a failed specialty save restores its saved selection and code availability',async()=>{
  const {run,byId,sandbox}=quickModule();
  run('hydrateUi(prefs)');
  sandbox.fetch=async()=>{throw Error('网络失败');};
  byId('quickSpecialty').value='申论';
  await byId('quickSpecialty').listeners.change();
  assert.equal(byId('quickSpecialty').value,'计算机 / 软件工程');
  assert.equal(byId('quickProgrammingLanguage').disabled,false);
  assert.match(byId('quickSettingsStatus').textContent,/网络失败/);
});

test('all saved profiles remain selectable even when their model names are identical',async()=>{
  const {run,byId}=quickModule();
  await run('loadModels()');
  const select=byId('quickModel');
  assert.deepEqual(select.options.map(option=>option.value),['personal','team']);
  assert.deepEqual(select.options.map(option=>option.textContent),['个人接口 · same-model','团队接口 · same-model']);
  assert.equal(select.value,'personal');
  assert.equal(select.disabled,false);
});

test('model selection activates its saved profile id instead of just the model name',async()=>{
  const {run,byId,requests}=quickModule();
  await run('loadModels()');
  const select=byId('quickModel');select.value='team';
  await select.listeners.change();
  const activation=requests.find(request=>request.path==='/api/config/llm/activate');
  assert.deepEqual(activation.body,{profile_id:'team'});
  assert.equal(select.value,'team');
  assert.equal(byId('quickSettingsStatus').textContent,'已保存。');
});

test('refresh reloads every saved source and uses the server active profile',async()=>{
  const {run,byId,models}=quickModule();
  await run('loadModels()');
  models.profiles.push({id:'new',name:'新增接口',llm_model:'third-model',llm_base_url:'https://new.example.test/v1'});
  models.active_profile_id='new';
  await byId('quickRefreshModels').listeners.click();
  assert.deepEqual(byId('quickModel').options.map(option=>option.value),['personal','team','new']);
  assert.equal(byId('quickModel').value,'new');
});

test('duplicate profile names include their source hosts and labels stay literal',async()=>{
  const {run,byId,models}=quickModule();
  for(const profile of models.profiles)profile.name='<img src=x>';
  await run('loadModels()');
  assert.match(byId('quickModel').options[0].textContent,/^<img src=x> · same-model · personal.example.test$/);
  assert.match(byId('quickModel').options[1].textContent,/team.example.test$/);
});

test('failed model activation restores the server selection and reports failure',async()=>{
  const {run,byId,sandbox,models}=quickModule();
  await run('loadModels()');
  sandbox.fetch=async(url)=>new URL(url).pathname.endsWith('/activate')
    ? {ok:false,json:async()=>({detail:'连接切换失败'})}
    : {ok:true,json:async()=>models};
  byId('quickModel').value='team';
  await byId('quickModel').listeners.change();
  assert.equal(byId('quickModel').value,'personal');
  assert.equal(byId('quickModel').disabled,false);
  assert.match(byId('quickSettingsStatus').textContent,/模型切换失败/);
});

test('a failed refresh keeps the last saved choices and does not report success',async()=>{
  const {run,byId,sandbox}=quickModule();
  await run('loadModels()');
  sandbox.fetch=async()=>{throw Error('网络失败');};
  await byId('quickRefreshModels').listeners.click();
  assert.equal(byId('quickModel').value,'personal');
  assert.equal(byId('quickModel').options.length,2);
  assert.match(byId('quickSettingsStatus').textContent,/模型列表读取失败/);
});

test('refresh and model selection stay disabled while activation is pending',async()=>{
  const {run,byId,sandbox,models}=quickModule();
  await run('loadModels()');
  let resolve;
  sandbox.fetch=()=>new Promise(r=>{resolve=r;});
  byId('quickModel').value='team';
  const pending=byId('quickModel').listeners.change();
  assert.equal(byId('quickRefreshModels').disabled,true);
  assert.equal(byId('quickModel').disabled,true);
  models.active_profile_id='team';
  resolve({ok:true,json:async()=>models});
  await pending;
  assert.equal(byId('quickRefreshModels').disabled,false);
  assert.equal(byId('quickModel').disabled,false);
});

function captureModule() {
  const sandbox={pending:[],sessionGeneration:1,savingSession:false,streaming:false,nextShotId:1,shotsExpanded:false,renders:0,status:'',
    renderPending(){sandbox.renders+=1;},setStatus(text){sandbox.status=text;}};
  const context=vm.createContext(sandbox);
  vm.runInContext(homeSource.slice(homeSource.indexOf('function addShots('),homeSource.indexOf('function readImageFile(')),context);
  return {sandbox,run:code=>vm.runInContext(code,context)};
}
const image={mime:'image/png',data:'cG5n'};

test('capture receives old single-image payloads and the complete new batch',()=>{
  const {sandbox,run}=captureModule();sandbox.one=image;sandbox.batch={images:[image,image]};
  run('receiveCapture(one);receiveCapture(batch)');
  assert.equal(sandbox.pending.length,3);
  assert.deepEqual(sandbox.pending.map(shot=>shot.id),['1','2','3']);
  assert.equal(sandbox.renders,2);
});

test('an over-capacity batch is rejected atomically with a visible count hint',()=>{
  const {sandbox,run}=captureModule();sandbox.batch={images:[image,image]};
  sandbox.pending.push(...Array.from({length:7},(_,i)=>({id:String(i)})));
  run('receiveCapture(batch)');
  assert.equal(sandbox.pending.length,7);
  assert.equal(sandbox.renders,0);
  assert.match(sandbox.status,/2 张图.*7 张.*8 张图/);
});

test('the eighth image slot is accepted but a ninth single image is rejected',()=>{
  const {sandbox,run}=captureModule();sandbox.batch={images:[image,image]};sandbox.one=image;
  sandbox.pending.push(...Array.from({length:6},(_,i)=>({id:String(i)})));
  run('receiveCapture(batch);receiveCapture(one)');
  assert.equal(sandbox.pending.length,8);
  assert.equal(sandbox.renders,1);
  assert.match(sandbox.status,/8 张图/);
});

test('malformed batches do not partially enqueue valid images',()=>{
  const {sandbox,run}=captureModule();sandbox.batch={images:[image,{}]};
  run('receiveCapture(batch)');
  assert.equal(sandbox.pending.length,0);
  assert.match(sandbox.status,/截图数据不完整/);
});

test('reset rejects old-generation work but accepts a new capture event',()=>{
  const {sandbox,run}=captureModule();sandbox.batch={images:[image,image]};sandbox.sessionGeneration=2;
  run('receiveCapture(batch,1)');assert.equal(sandbox.pending.length,0);
  run('receiveCapture(batch,sessionGeneration)');assert.equal(sandbox.pending.length,2);
});

test('saving and streaming reject a whole batch without losing only one image',()=>{
  const {sandbox,run}=captureModule();sandbox.batch={images:[image,image]};sandbox.savingSession=true;
  run('receiveCapture(batch)');assert.equal(sandbox.pending.length,0);
  sandbox.savingSession=false;sandbox.streaming=true;
  run('receiveCapture(batch)');assert.equal(sandbox.pending.length,0);
  assert.match(sandbox.status,/正在生成回答/);
});

function armedModule() {
  const classes=new Set(['liuwa-armed']);let armedHandler;let resolve;
  const classList={remove:name=>classes.delete(name),add:name=>classes.add(name),toggle(name,on){if(on)classes.add(name);else classes.delete(name);}};
  const cockpit={onArmed:handler=>{armedHandler=handler;},getConfig:()=>new Promise(r=>{resolve=r;})};
  const sandbox={document:{documentElement:{classList},body:{classList}},state:{},applyHotkeyHints(){},applyTheme(){},applyDisplay(){}};
  const context=vm.createContext(sandbox);sandbox.cockpit=cockpit;
  vm.runInContext(homeSource.slice(homeSource.indexOf('function wireDesktop('),homeSource.indexOf('\nwindow.cycleTheme')),context);
  vm.runInContext('wireDesktop(cockpit)',context);
  return {classes,armed:value=>armedHandler(value),resolve:config=>resolve(config)};
}

test('desktop boot starts unarmed and hydrates the initial native armed state',async()=>{
  const {classes,resolve}=armedModule();assert.equal(classes.has('liuwa-armed'),false);
  resolve({armed:true,display:{}});await Promise.resolve();
  assert.equal(classes.has('liuwa-armed'),true);
});

test('a newer native armed event wins over a late startup config response',async()=>{
  const {classes,armed,resolve}=armedModule();armed(false);resolve({armed:true,display:{}});await Promise.resolve();
  assert.equal(classes.has('liuwa-armed'),false);
});
