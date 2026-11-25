import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../web/modules/markdown.js';
import { page, readingBox, scrollByScreen } from '../web/modules/reading.js';
import { renderAnswer, stepAnswerTab, exportAnswerReadingState, restoreAnswerReadingState } from '../web/modules/answer-view.js';

function answerFixture() {
  const doc={activeElement:null,createElement(){
    const attributes={};
    const button={dataset:{},style:{},hidden:false,textContent:'',setAttribute:(name,value)=>{attributes[name]=value;},getAttribute:name=>attributes[name],closest:()=>button,focus(){doc.activeElement=button;},click(){tabs.onclick({target:button});}};
    return button;
  }};
  const tabs={hidden:false,dataset:{},ownerDocument:doc,buttons:[],contains:node=>tabs.buttons.includes(node),replaceChildren(...buttons){this.buttons=buttons;},querySelectorAll:()=>tabs.buttons,querySelector:selector=>tabs.buttons.find(button=>selector.includes(`"${button.dataset.panel}"`))};
  const root={innerHTML:'',scrollTop:0,dataset:{},ownerDocument:doc,closest:selector=>selector==='.liuwa-reader'?{querySelector:()=>tabs}:null,setAttribute(){},dispatchEvent(){}};
  return {root,tabs,button:key=>tabs.buttons.find(button=>button.dataset.panel===key)};
}

test('an untyped answer opens its answer section while retaining the complete source', () => {
  const root = { innerHTML: '', scrollTop: 120 };
  const model = renderAnswer('## 解题思路\n先排序。\n\n## 答案\n42', root, {complete:true});
  assert.doesNotMatch(root.innerHTML, /先排序。/);
  assert.match(root.innerHTML, /42/);
  assert.match(model.full, /先排序。/);
  assert.equal(model.selected, 'answer');
  assert.equal(root.scrollTop, 0);
});

test('programming streams keep the answer first before and after code arrives',()=>{
  const root={innerHTML:'',scrollTop:0,dataset:{}};
  renderAnswer('<!-- li',root);
  assert.equal(root.innerHTML,'');assert.equal(root.dataset.hasAnswer,'false');
  renderAnswer('<!-- liuwa:type=programming -->\n## 答案',root);
  assert.equal(root.innerHTML,'');assert.equal(root.dataset.hasAnswer,'false');
  const answer='<!-- liuwa:type=programming -->\n## 答案\n使用二分查找。';
  assert.equal(renderAnswer(answer,root).selected,'answer');
  const model=renderAnswer(answer+'\n## 代码\n```java\nreturn 42;\n```\n## 解题思路\n缩小区间。',root,{complete:true});
  assert.equal(model.selected,'answer');assert.match(root.innerHTML,/二分查找/);assert.doesNotMatch(root.innerHTML,/return 42/);
});

test('existing stream content stays visible until a later answer can take priority',()=>{
  for(const [type,body,before] of [
    ['programming','## 代码\n```java\nreturn 42;\n```','code'],
    ['mixed','## 代码\n```java\nreturn 42;\n```','all'],
    ['reasoning','## 解题思路\n先分析条件。','thought'],
  ]) {
    const root={innerHTML:'',scrollTop:0,dataset:{}};
    const source=`<!-- liuwa:type=${type} -->\n${body}`;
    assert.equal(renderAnswer(source,root).selected,before);
    assert.equal(root.dataset.hasAnswer,'true');assert.notEqual(root.innerHTML,'');
    assert.equal(renderAnswer(source+'\n## 答案\n结论成立。',root).selected,'answer');
    assert.match(root.innerHTML,/结论成立/);
  }
});

test('code-only history and hints do not wait in a nonexistent answer panel',()=>{
  const codeRoot={innerHTML:'',scrollTop:0,dataset:{}};
  const code=renderAnswer('<!-- liuwa:type=programming -->\n## 代码\n```java\nreturn 42;\n```',codeRoot,{complete:true});
  assert.equal(code.selected,'code');assert.match(codeRoot.innerHTML,/return 42/);
  const hintRoot={innerHTML:'',scrollTop:0,dataset:{}};
  const hints=renderAnswer('<!-- liuwa:type=reasoning -->\n## 解题思路\n先找不变量。',hintRoot,{complete:true});
  assert.equal(hints.selected,'thought');assert.match(hintRoot.innerHTML,/不变量/);assert.ok(!hints.panels.some(p=>p.key==='answer'));
});

test('manual sections and scroll positions survive later deltas and retain keyboard navigation',()=>{
  const {root,tabs,button}=answerFixture();
  const first='<!-- liuwa:type=programming -->\n## 答案\n42\n## 解题思路\n逐步缩小范围。';
  renderAnswer(first,root);
  button('thought').click();root.scrollTop=180;
  const full=first+'\n## 代码\n```java\nreturn 42;\n```';
  const result=renderAnswer(full,root);
  assert.equal(result.selected,'thought');assert.equal(root.scrollTop,180);assert.doesNotMatch(root.innerHTML,/return 42/);
  tabs.onkeydown({target:button('thought'),key:'ArrowLeft',preventDefault(){}});
  assert.equal(root.dataset.answerPanel,'code');assert.match(root.innerHTML,/return 42/);
  tabs.onkeydown({target:button('code'),key:'Home',preventDefault(){}});
  assert.equal(root.dataset.answerPanel,'answer');
  tabs.onkeydown({target:button('answer'),key:'End',preventDefault(){}});
  assert.equal(root.dataset.answerPanel,'all');
  assert.equal(stepAnswerTab(1,root),true);assert.equal(root.dataset.answerPanel,'answer');
  button('thought').click();assert.equal(root.scrollTop,180);
  assert.equal(renderAnswer(full,root,{complete:true}).selected,'thought');assert.equal(root.scrollTop,180);
});

test('full reader state restores every section on a replacement root and remains manually selected',()=>{
  const source='## 答案\n答案正文。\n## 代码\n```java\nreturn 42;\n```\n## 解题思路\n逐步推导。';
  const old=answerFixture();renderAnswer(source,old.root,{complete:true});old.root.scrollTop=70;
  old.button('thought').click();old.root.scrollTop=140;old.button('code').click();old.root.scrollTop=210;
  const state=exportAnswerReadingState(old.root);
  const fresh=answerFixture();renderAnswer(source,fresh.root,{complete:true});
  assert.equal(restoreAnswerReadingState(fresh.root,state),true);
  assert.equal(fresh.root.dataset.answerPanel,'code');assert.equal(fresh.root.scrollTop,210);
  fresh.button('answer').click();assert.equal(fresh.root.scrollTop,70);
  fresh.button('thought').click();assert.equal(fresh.root.scrollTop,140);
  renderAnswer(source+'\n补充思路。',fresh.root);
  assert.equal(fresh.root.dataset.answerPanel,'thought');assert.equal(fresh.root.scrollTop,140);
  fresh.root.scrollTop=300;
  assert.equal(state.positions.thought,140);
});

test('reader state ignores obsolete panels and cannot share mutable position storage',()=>{
  const f=answerFixture();renderAnswer('## 答案\n42',f.root,{complete:true});
  const state={selected:'code',manual:true,positions:{answer:80,code:200,thought:-1,bogus:12}};
  assert.equal(restoreAnswerReadingState(f.root,state),true);state.positions.answer=500;
  assert.equal(f.root.dataset.answerPanel,'answer');assert.equal(f.root.scrollTop,80);
  assert.deepEqual(exportAnswerReadingState(f.root).positions,{answer:80});
  assert.equal(restoreAnswerReadingState({},state),false);
});

test('math-looking lines inside a code fence stay literal, including while streaming', () => {
  const source = '```sh\n$$HOME$$\n\\[\necho hello\n\\]\n';
  const rendered = renderMarkdown(source);
  assert.doesNotMatch(rendered, /md-math/);
  assert.match(rendered, /\$\$HOME\$\$/);
  assert.match(rendered, /echo hello/);
  assert.match(rendered, /<pre/);
});

test('numeric formulas render without treating separate currency prices as math', () => {
  assert.match(renderMarkdown('常数为 $6$，结果为 $0$。'), /md-math-fallback">6</);
  assert.doesNotMatch(renderMarkdown('常数为 $6$。'), /\$6\$/);
  assert.doesNotMatch(renderMarkdown('费用 $5，预算 $10。'), /md-math/);
});

test('reading keys scroll the visible answer when the card owns the scrollbar', () => {
  const moves = [];
  const card = {
    clientHeight: 500, scrollHeight: 2000, scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 }),
    scrollBy: (move) => moves.push(move.top),
  };
  const thread = {
    clientHeight: 550, scrollHeight: 550, scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 550, height: 550 }),
    querySelectorAll: () => [card],
    querySelector: () => card,
    scrollBy: () => assert.fail('the outer thread has no scrollable content'),
  };
  globalThis.document = { querySelector: () => thread };
  try {
    page(1);
    page(-1);
    scrollByScreen(0.5);
    assert.deepEqual(moves, [425, -425, 250]);
  } finally {
    delete globalThis.document;
  }
});

test('the current answer remains the reading target before it becomes scrollable', () => {
  const card = { clientHeight: 500, scrollHeight: 500, scrollTop: 0 };
  const thread = {
    querySelector: () => card,
    querySelectorAll: () => [card],
    getBoundingClientRect: () => ({top:0,bottom:550,height:550}),
  };
  globalThis.document = { querySelector: () => thread };
  try {
    assert.equal(readingBox(), card);
    card.scrollHeight = 2000;
    assert.equal(readingBox(), card);
  } finally { delete globalThis.document; }
});

test('code blocks keep the line numbers and copy button outside the code itself', () => {
  const rendered = renderMarkdown('```java\nint a = 1;\nint b = 2;\n```');
  const gutter = rendered.match(/md-code-gutter[^>]*>([^<]+)</)?.[1] || '';
  assert.equal(gutter, '1\n2');
  const code = rendered.match(/<pre class="md-code"[^>]*>(.*)<\/pre>/)?.[1] || '';
  assert.doesNotMatch(code, /md-copy|md-code-gutter/);
  assert.match(rendered, /md-code-lang">java</);
  assert.match(rendered, /aria-label="复制代码"/);
});

test('an unterminated fence still renders a block while streaming', () => {
  const rendered = renderMarkdown('## 代码\n```python\nfor i in range(3):');
  assert.match(rendered, /md-code-block/);
  assert.match(rendered, /for i in range\(3\):/);
});
