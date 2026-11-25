const BLOCKED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'bower_components', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', 'target', '.next', '.nuxt', 'coverage', 'output', '.ssh', '.aws', '.azure', '.kube', '.config', '.claude', '.idea', '.cache', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.terraform']);
const SECRET_NAME = /^(?:\.env.*|(?:credentials?|secrets?|tokens?|passwords?|private[-_]?keys?)(?:[._-].*)?|service[-_]?account(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|(?:asr|model)_profiles\.json|knowledge-sources\.json|.*\.(?:pem|key|p12|pfx|keystore))$/i;

export function safeKnowledgePath(path) {
  if (typeof path !== 'string' || !path || path.length > 500 || /[\\\x00-\x1f:]|^\//.test(path)) return false;
  const parts = path.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !BLOCKED_DIRECTORIES.has(part.toLowerCase()) && !SECRET_NAME.test(part));
}

function glob(pattern) {
  let result = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\' && index + 1 < pattern.length) { result += pattern[++index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (char === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end > index + 1) {
        let group = pattern.slice(index + 1, end);
        if (group.startsWith('!')) group = '^' + group.slice(1);
        result += '[' + group.replaceAll('\\', '\\\\') + ']'; index = end; continue;
      }
    }
    if (char === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') { index += 1; result += '(?:.*/)?'; }
      else result += '.*';
    } else if (char === '*') result += '[^/]*';
    else if (char === '?') result += '[^/]';
    else result += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return result;
}

export function ignoreRules(text, directory = '') {
  return text.split(/\r?\n/).flatMap(raw => {
    let line = raw.trimEnd();
    if (!line || line.startsWith('#')) return [];
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    const folder = line.endsWith('/');
    if (folder) line = line.slice(0, -1);
    if (!line) return [];
    const prefix = anchored || line.includes('/') ? '^' : '(?:^|/)';
    return [{ directory, negate, folder, expression: new RegExp(prefix + glob(line) + '(?:$|/)') }];
  });
}

export function ignoredPath(path, rules) {
  const parts = path.split('/');
  for (let end = 1; end <= parts.length; end += 1) {
    const candidate = parts.slice(0, end).join('/');
    let ignored = false;
    for (const rule of rules) {
      if (rule.directory && !candidate.startsWith(rule.directory + '/')) continue;
      if (rule.folder && end === parts.length) continue;
      const local = rule.directory ? candidate.slice(rule.directory.length + 1) : candidate;
      if (rule.expression.test(local)) ignored = !rule.negate;
    }
    if (ignored) return true;
  }
  return false;
}

export async function prepareBrowserFiles(files, capabilities, folder = false) {
  if (files.length > 5000) throw new Error('文件过多，请选择更小的文档文件夹。');
  const root = folder ? files[0]?.webkitRelativePath?.split('/')[0] || '' : '';
  const candidates = files.map(file => ({ file, path: folder ? file.webkitRelativePath.slice(root.length + 1) : file.name }));
  const rules = [];
  const ignores = candidates.filter(item => item.path.endsWith('.gitignore') && safeKnowledgePath(item.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const item of ignores) {
    if (item.file.size > 128 * 1024) throw new Error('.gitignore 过大，请改为选择需要的文件。');
    const directory = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
    rules.push(...ignoreRules(await item.file.text(), directory));
  }
  const accepted = [], skipped = [], seen = new Set();
  let bytes = 0;
  for (const item of candidates) {
    const suffix = '.' + item.path.split('.').pop().toLowerCase();
    let reason = '';
    if (!safeKnowledgePath(item.path)) reason = '敏感文件或不安全路径';
    else if (ignoredPath(item.path, rules)) reason = '.gitignore 已排除';
    else if (!capabilities.suffixes.includes(suffix)) reason = '不支持的文件类型';
    else if (!item.file.size) reason = '空文件';
    else if (item.file.size > capabilities.max_file_bytes) reason = '超过单文件大小限制';
    if (reason) { if (skipped.length < 200) skipped.push({ path: item.path, reason }); continue; }
    if (seen.has(item.path)) throw new Error('存在同名文件，请分开导入或选择文件夹保留目录。');
    seen.add(item.path);
    bytes += item.file.size;
    accepted.push(item);
    if (bytes > capabilities.max_total_bytes || accepted.length > capabilities.max_files) throw new Error('导入总量超限，请选择更小的文件夹。');
  }
  return { name: root || files[0]?.name?.replace(/\.[^.]+$/, '') || '项目资料', files: accepted, skipped, kind: folder ? 'folder' : 'files' };
}
