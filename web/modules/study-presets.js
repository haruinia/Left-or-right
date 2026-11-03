export const SPECIALTY_GROUPS = [
  { label: "技术与工程", values: [
    "计算机 / 软件工程", "前端开发", "后端开发", "全栈开发", "移动开发",
    "测试开发", "运维 / SRE", "数据工程", "数据分析", "人工智能 / 机器学习",
    "网络与信息安全", "嵌入式开发", "电子信息", "机械工程", "建筑工程",
  ] },
  { label: "考试与资格", values: [
    "行测", "申论", "考研", "英语", "金融", "法学", "医学", "会计", "教师资格",
  ] },
  { label: "综合学习", values: ["通用学习", "数学", "物理", "化学", "生物", "管理学", "教育学"] },
];

export const LANGUAGE_GROUPS = [
  { label: "常用语言", values: [
    "Python", "Java", "C++", "C", "JavaScript", "TypeScript", "Go", "Rust", "C#",
    "Kotlin", "Swift", "PHP", "Ruby", "SQL", "R", "Scala", "Dart", "Objective-C", "Bash",
  ] },
  { label: "其他语言", values: ["Lua", "MATLAB", "Julia", "Perl", "Haskell", "Elixir", "Clojure", "PowerShell", "Solidity", "CUDA", "Verilog", "SystemVerilog"] },
];

// Keep these values aligned with the exam guides in services/chat_service/service.py.
export const EXAM_SPECIALTIES = SPECIALTY_GROUPS[1].values;
export const CUSTOM_STUDY_VALUE = "__custom__";

export function isExamSpecialty(value) {
  return EXAM_SPECIALTIES.includes(String(value || "").trim());
}

export function fillStudyChoice(select, customInput, groups, value = "") {
  const selected = String(value || "");
  const known = groups.some((group) => group.values.includes(selected));
  const options = [new Option("按题目要求", "")];
  for (const { label, values } of groups) {
    const group = document.createElement("optgroup");
    group.label = label;
    group.append(...values.map((item) => new Option(item, item)));
    options.push(group);
  }
  if (selected && !known) options.push(new Option(selected, selected));
  options.push(new Option("自定义…", CUSTOM_STUDY_VALUE));
  select.replaceChildren(...options);
  select.value = selected;
  customInput.value = selected && !known ? selected : "";
  syncStudyCustom(select, customInput);
}

export function syncStudyCustom(select, customInput) {
  const custom = select.value === CUSTOM_STUDY_VALUE;
  customInput.hidden = !custom;
  customInput.disabled = !custom || select.disabled;
}

export function readStudyChoice(select, customInput) {
  return (select.value === CUSTOM_STUDY_VALUE ? customInput.value : select.value).trim();
}
