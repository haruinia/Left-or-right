import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../web/modules/knowledge-files.js', import.meta.url), 'utf8');
const { safeKnowledgePath, ignoreRules, ignoredPath, prepareBrowserFiles } = await import('data:text/javascript,' + encodeURIComponent(source));
const capabilities = { suffixes: ['.md', '.txt', '.js'], max_file_bytes: 1024, max_files: 10, max_total_bytes: 2048 };
function file(path, text = 'synthetic document') {
  const value = new File([text], path.split('/').pop());
  Object.defineProperty(value, 'webkitRelativePath', { value: path });
  return value;
}

for (const path of ['../doc.md', '/tmp/doc.md', 'C:/doc.md', 'docs\\doc.md', 'docs//doc.md', '.env', '.env.local', '.envproduction', 'docs/credentials.json', 'docs/service-account.json', 'tokens.json', 'model_profiles.json', '.aws/config.txt', 'node_modules/index.js', 'private_key.json']) {
  test(`browser import excludes unsafe or sensitive path ${path}`, () => assert.equal(safeKnowledgePath(path), false));
}
test('browser import allows project relative paths and Unicode filenames', () => {
  assert.equal(safeKnowledgePath('docs/设计说明.md'), true);
  assert.equal(safeKnowledgePath('src/service.js'), true);
});
test('gitignore handles nesting, directory exclusions and non-resurrection', () => {
  const rules = [...ignoreRules('drafts/\n*.txt\n!important.txt\n/root.md\n**/generated*.md'), ...ignoreRules('local.md', 'docs')];
  for (const path of ['drafts/file.md', 'docs/notes.txt', 'root.md', 'a/generated-1.md', 'docs/local.md']) assert.equal(ignoredPath(path, rules), true, path);
  assert.equal(ignoredPath('important.txt', rules), false);
  assert.equal(ignoredPath('docs/root.md', rules), false);
  assert.equal(ignoredPath('else/local.md', rules), false);
  assert.equal(ignoredPath('drafts/important.txt', [...rules, ...ignoreRules('!drafts/important.txt')]), true);
});
test('gitignore supports escaped literals and character groups', () => {
  const rules = ignoreRules('\\#private.md\nfile[0-9].md\nspace\\ name.md');
  for (const path of ['#private.md', 'file4.md', 'space name.md']) assert.equal(ignoredPath(path, rules), true, path);
  assert.equal(ignoredPath('filex.md', rules), false);
});
test('folder uploads retain paths and respect uploaded gitignore before reading documents', async () => {
  const result = await prepareBrowserFiles([file('project/.gitignore', 'skip/\n*.txt\n!important.txt'), file('project/docs/readme.md'), file('project/skip/no.md'), file('project/note.txt'), file('project/important.txt'), file('project/.env', 'not a real secret')], capabilities, true);
  assert.equal(result.name, 'project');
  assert.deepEqual(result.files.map(item => item.path), ['docs/readme.md', 'important.txt']);
  assert.ok(result.skipped.some(item => item.path === '.env'));
});
test('file and aggregate limits fail before starting uploads', async () => {
  await assert.rejects(prepareBrowserFiles([file('a.md'), file('b.md')], { ...capabilities, max_files: 1 }), /总量超限/);
  await assert.rejects(prepareBrowserFiles([file('a.md'), file('b.md')], { ...capabilities, max_total_bytes: 5 }), /总量超限/);
  const result = await prepareBrowserFiles([file('large.md', 'x'.repeat(1025))], capabilities);
  assert.equal(result.files.length, 0);
  assert.match(result.skipped[0].reason, /单文件/);
});
test('duplicate base filenames cannot silently overwrite a document', async () => {
  await assert.rejects(prepareBrowserFiles([file('one/a.md'), file('two/a.md')], capabilities), /同名文件/);
});
test('oversized ignore rules fail closed', async () => {
  await assert.rejects(prepareBrowserFiles([file('project/.gitignore', 'x'.repeat(128 * 1024 + 1))], capabilities, true), /gitignore 过大/);
});
