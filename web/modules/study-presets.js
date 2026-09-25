// Keep in sync with services/chat_service/service.py exam guides and the settings datalist.
export const EXAM_SPECIALTIES = [
  "行测",
  "申论",
  "考研",
  "英语",
  "金融",
  "法学",
  "医学",
  "会计",
  "教师资格",
];

export function isExamSpecialty(value) {
  return EXAM_SPECIALTIES.includes(String(value || "").trim());
}
