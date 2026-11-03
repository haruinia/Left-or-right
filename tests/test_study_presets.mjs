import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../web/modules/study-presets.js',import.meta.url),'utf8');
function setup() {
  class Element {
    constructor(tag='select') {this.tagName=tag.toUpperCase();this.children=[];this.value='';this.disabled=false;this.hidden=false;}
    append(...children) {this.children.push(...children);}
    replaceChildren(...children) {this.children=children;}
    get options() {return this.children.flatMap(item=>item.tagName==='OPTGROUP'?item.options:[item]);}
  }
  class Option extends Element {constructor(text,value) {super('option');this.textContent=text;this.value=value;}}
  const sandbox={document:{createElement:tag=>new Element(tag)},Option,select:new Element(),input:new Element('input')};
  const context=vm.createContext(sandbox);
  vm.runInContext(source.replace(/^export /gm,''),context);
  return {...sandbox,run:code=>vm.runInContext(code,context)};
}

test('both sets have unique values, required exam directions and a wide language list',()=>{
  const {run}=setup();
  for(const name of ['SPECIALTY_GROUPS','LANGUAGE_GROUPS']) {
    const values=Array.from(run(`${name}.flatMap(group=>group.values)`));
    assert.equal(new Set(values).size,values.length);
    assert.ok(values.length>=30);
  }
  assert.equal(run('isExamSpecialty("行测")'),true);
  assert.equal(run('isExamSpecialty("申论")'),true);
  assert.equal(run('isExamSpecialty("后端开发")'),false);
});

test('opening a known language always retains every option and an explicit blank choice',()=>{
  const {run,select,input}=setup();
  run('fillStudyChoice(select,input,LANGUAGE_GROUPS,"Go")');
  assert.equal(select.value,'Go');
  assert.equal(input.hidden,true);
  assert.ok(select.options.some(option=>option.value==='Java'));
  assert.ok(select.options.some(option=>option.value==='CUDA'));
  assert.equal(select.options[0].value,'');
  assert.equal(select.options.at(-1).value,'__custom__');
});

test('unknown saved values are literal options and do not replace existing choices',()=>{
  const {run,select,input}=setup();
  run('fillStudyChoice(select,input,SPECIALTY_GROUPS,"<img src=x>")');
  assert.equal(select.value,'<img src=x>');
  assert.equal(select.options.find(option=>option.value==='<img src=x>').textContent,'<img src=x>');
  assert.ok(select.options.some(option=>option.value==='行测'));
  assert.equal(input.hidden,true);
});

test('custom editor never exposes its internal selection marker as a preference',()=>{
  const {run,select,input}=setup();
  run('fillStudyChoice(select,input,LANGUAGE_GROUPS,"Rust")');
  select.value='__custom__';
  run('syncStudyCustom(select,input)');
  assert.equal(input.hidden,false);
  assert.equal(input.disabled,false);
  input.value='  OCaml  ';
  assert.equal(run('readStudyChoice(select,input)'),'OCaml');
  select.disabled=true;
  run('syncStudyCustom(select,input)');
  assert.equal(input.disabled,true);
});

test('every offered exam direction has a matching backend prompt guide',()=>{
  const {run}=setup();
  const backend=fs.readFileSync(new URL('../services/chat_service/service.py',import.meta.url),'utf8');
  for(const name of run('EXAM_SPECIALTIES'))assert.ok(backend.includes(`"${name}":`),name);
});
