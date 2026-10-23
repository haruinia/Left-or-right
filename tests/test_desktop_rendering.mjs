import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../web/modules/markdown.js';
import { page, readingBox, scrollByScreen } from '../web/modules/reading.js';
import { renderAnswer } from '../web/modules/answer-view.js';

test('an untyped answer opens its answer section while retaining the complete source', () => {
  const root = { innerHTML: '', scrollTop: 120 };
  const model = renderAnswer('## 解题思路\n先排序。\n\n## 答案\n42', root, {complete:true});
  assert.doesNotMatch(root.innerHTML, /先排序。/);
  assert.match(root.innerHTML, /42/);
  assert.match(model.full, /先排序。/);
  assert.equal(model.selected, 'answer');
  assert.equal(root.scrollTop, 0);
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
