"""读取面试 ASR 热词库（data/asr_hotwords.txt），去重、自动赋权重，导出为可创建
阿里云 NLS 热词表的格式。

权重规则（NLS 1-5，越高越优先纠正）：英文缩写/短码=5，含英文的词=4，中文术语=3。

用法：
  python -m scripts.create_nls_vocabulary             # 预览词表（供阿里云控制台粘贴）
  python -m scripts.create_nls_vocabulary --json      # 导出 NLS Words JSON（词+权重+语言）

创建热词表（任选其一）：
  A. 阿里云智能语音交互控制台 →「热词」→ 新建词表 → 粘贴上面的词 → 保存得到 vocabulary_id。
  B. 用本脚本 --json 的输出，通过 NLS 热词 OpenAPI / 控制台导入。
得到 vocabulary_id 后填入 .env 的 ALIYUN_NLS_VOCABULARY_ID，重启 gateway 生效。
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

HOTWORDS_FILE = Path(__file__).resolve().parent.parent / "data" / "asr_hotwords.txt"

_ASCII_CODE = re.compile(r"^[A-Za-z0-9.+#/_-]+$")
_HAS_LATIN = re.compile(r"[A-Za-z]")


def load_hotwords(path: Path = HOTWORDS_FILE) -> list[str]:
    """读取热词库，去掉注释/空行，按出现顺序去重。"""
    words: list[str] = []
    seen: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        word = raw.strip()
        if not word or word.startswith("#"):
            continue
        if word in seen:
            continue
        seen.add(word)
        words.append(word)
    return words


def weight_of(word: str) -> int:
    """权重 5 给最易错的缩写/技术码（全大写缩写、含数字、含 +#/. 符号），普通英文词 4，中文术语 3。"""
    if _ASCII_CODE.match(word):
        is_acronym = sum(ch.isalpha() for ch in word) >= 2 and word == word.upper()
        if is_acronym or any(ch.isdigit() for ch in word) or any(ch in "+#/." for ch in word):
            return 5
        return 4
    if _HAS_LATIN.search(word):
        return 4
    return 3


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="create_nls_vocabulary",
        description="读取面试 ASR 热词库，去重赋权重，导出为可创建阿里云 NLS 热词表的格式。",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="输出 NLS 热词表 Words JSON（词+权重+语言），用于 API/控制台导入",
    )
    return parser


def main() -> None:
    args = _build_arg_parser().parse_args()
    words = load_hotwords()
    if args.json:
        items = [{"word": word, "weight": weight_of(word), "lang": "zh"} for word in words]
        print(json.dumps(items, ensure_ascii=False, indent=2))
        return
    print(f"# 面试 ASR 热词表：共 {len(words)} 个（已去重）")
    print("# 粘贴到阿里云智能语音交互控制台「热词」新建词表，保存后得到 vocabulary_id")
    print(f"# 填入 .env：ALIYUN_NLS_VOCABULARY_ID=<vocabulary_id>，重启 gateway 生效\n")
    for word in words:
        print(word)


if __name__ == "__main__":
    main()
