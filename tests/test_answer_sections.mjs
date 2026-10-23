import assert from 'node:assert/strict';
import test from 'node:test';
import {splitAnswer, stripAnswerMetadata} from '../web/modules/answer-sections.js';
import {renderMarkdown} from '../web/modules/markdown.js';
import {stepAnswerTab} from '../web/modules/answer-view.js';

for (const [type,content,preferred] of [
  ['choice','## 解题思路\n排除其他选项\n## 答案\nB. TCP\n## 详细解析\n可靠传输。','answer'],
  ['programming','## 解题思路\n二分\n## 代码\n```python\nprint(42)\n```\n## 复杂度分析\nO(1)','code'],
  ['reasoning','## 解题思路\n先找不变量\n## 详细解析\n分情况讨论','thought'],
  ['essay','## 写作思路\n围绕材料\n## 参考作答\n推动公共服务向基层延伸。\n## 材料分析\n材料一与材料二','answer'],
  ['calculation','## 答案\n$6$ 米\n## 详细解析\n$2+4=6$','answer'],
  ['mixed','## 第一题\n### 答案\nB\n## 第二题\n### 代码\n```py\nprint(1)\n```','all'],
]) test(`${type} opens ${preferred} independently of source order`,()=>{
  const model = splitAnswer(`<!-- liuwa:type=${type} -->\n${content}`);
  assert.equal(model.preferred,preferred);
  assert.equal(model.panels[0].key,preferred);
  assert.equal(model.full,content);
  assert.doesNotMatch(renderMarkdown(`<!-- liuwa:type=${type} -->\n${content}`),/liuwa:type/);
  assert.ok(model.panels.find(p=>p.key===preferred).hasContent);
});

test('fences, inner headings and formula lines are not mistaken for section boundaries',()=>{
  const code='## 代码\n````python\n## 答案\n```\nprint("# 思路")\n````\n## 解题思路\n### 关键观察\n$$\nx=2\n$$';
  const model=splitAnswer(code);
  assert.equal(model.preferred,'code');
  assert.match(model.panels.find(p=>p.key==='code').markdown,/## 答案/);
  assert.equal(model.panels.some(p=>p.key==='answer'),false);
  assert.match(model.panels.find(p=>p.key==='thought').markdown,/关键观察/);
});

test('repeated question sections retain their question labels and unknown content remains accessible',()=>{
  const source='说明：按题号阅读。\n## 第1题\n### 答案\nB\n### 解析\nTCP\n## 第2题\n### 答案\nC\n### 解析\nUDP\n## 其他限制\n不要遗漏。';
  const model=splitAnswer(source);
  const answer=model.panels.find(p=>p.key==='answer').markdown;
  assert.match(answer,/第1题/);assert.match(answer,/第2题/);
  assert.match(model.panels.find(p=>p.key==='other').markdown,/不要遗漏/);
  assert.equal(model.full,source);
});

test('unstructured and misleadingly named answers fall back to the complete text',()=>{
  const source='## 如何分析代码中的答案变量\n这不是代码实现小节。\n```js\nconst answer = 42;\n```';
  const model=splitAnswer(source);
  assert.deepEqual(model.panels.map(p=>p.key),['all']);
  assert.equal(model.preferred,'all');
});

test('a partially streamed metadata marker is hidden and absent preferred content is not fabricated',()=>{
  assert.equal(stripAnswerMetadata('<!-- liuwa:type=pro').text,'');
  const model=splitAnswer('<!-- liuwa:type=programming -->\n## 解题思路\n先排序');
  assert.equal(model.preferred,'code');
  assert.equal(model.panels.find(p=>p.key==='code').hasContent,false);
  assert.equal(model.panels.find(p=>p.key==='thought').hasContent,true);
});

test('general answers with a code section infer programming and open code first',()=>{
  const source='<!-- liuwa:type=general -->\n## 答案\n查询活跃用户。\n## 代码\n```sql\nSELECT * FROM users WHERE active = 1;\n```';
  const model=splitAnswer(source);
  assert.equal(model.type,'programming');
  assert.equal(model.preferred,'code');
  assert.equal(model.panels[0].key,'code');
  assert.match(model.panels.find(p=>p.key==='code').markdown,/```sql/);
});

test('stepAnswerTab switches between tabs in left and right direction', () => {
  const clicked = [];
  const btnAnswer = {
    dataset: { panel: 'answer' },
    getAttribute: attr => attr === 'aria-selected' ? 'true' : null,
    click: () => clicked.push('answer'),
  };
  const btnThought = {
    dataset: { panel: 'thought' },
    getAttribute: attr => attr === 'aria-selected' ? 'false' : null,
    click: () => clicked.push('thought'),
  };
  const btnCode = {
    dataset: { panel: 'code' },
    getAttribute: attr => attr === 'aria-selected' ? 'false' : null,
    click: () => clicked.push('code'),
  };
  const tabs = {
    hidden: false,
    querySelectorAll: selector => selector.includes('button') ? [btnAnswer, btnThought, btnCode] : [],
  };
  const doc = {
    querySelector: sel => sel === '#liuwaAnswerTabs' ? tabs : null,
  };

  assert.equal(stepAnswerTab(1, { ownerDocument: doc }), true);
  assert.deepEqual(clicked, ['thought']);

  clicked.length = 0;
  assert.equal(stepAnswerTab(-1, { ownerDocument: doc }), true);
  assert.deepEqual(clicked, ['code']);
});

