// 章节来自实际返回的 Markdown；只定位，不裁剪或重排模型答案。
export function syncSections(root, select) {
  if (!root || !select) return;
  const headings = [...root.querySelectorAll('.md-heading')];
  const titles = headings.map(node => node.textContent.trim());
  const signature = JSON.stringify(titles);
  if (select.dataset.sections !== signature) {
    const selected = select.value;
    select.replaceChildren(new Option('定位章节…', ''), ...titles.map((title, index) => new Option(title, String(index))));
    select.dataset.sections = signature;
    if (select.querySelector(`option[value="${selected}"]`)) select.value = selected;
  }
  select.hidden = headings.length < 2;
}

export function jumpToSection(root, index) {
  if (!root || index === '') return;
  const heading = root.querySelectorAll('.md-heading')[Number(index)];
  if (!heading) return;
  const top = heading.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
  root.scrollTo({top: Math.max(0, top - 12), behavior: 'smooth'});
}
