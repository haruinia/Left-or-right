import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../web/modules/markdown.js';
import { page, readingBox, scrollByScreen } from '../web/modules/reading.js';
import { renderAnswer } from '../web/modules/answer-view.js';

test('a multi-section answer stays visible in source order without tabs', () => {
  const root = { innerHTML: '', scrollTop: 120 };
  renderAnswer('## 解题思路\n先排序。\n\n## 答案\n42', root);
  assert.match(root.innerHTML, /先排序。/);
  assert.match(root.innerHTML, /42/);
  assert.ok(root.innerHTML.indexOf('解题思路') < root.innerHTML.indexOf('答案'));
  assert.doesNotMatch(root.innerHTML, /tablist|tabpanel/);
  assert.equal(root.scrollTop, 120);
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
