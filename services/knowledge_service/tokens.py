from __future__ import annotations

import re

_TOKEN = re.compile(r"[a-z][a-z0-9_]*(?:\+\+|#|(?:[.-][a-z0-9_]+)*)|[一-鿿]+", re.IGNORECASE)
_ENGLISH_STOP = frozenset({
    "a", "about", "an", "and", "answer", "answers", "are", "as", "at", "be", "between",
    "by", "can", "compare", "comparison", "could", "describe", "detail", "details", "difference",
    "differences", "discuss", "do", "does", "example", "examples", "explain", "for", "from", "had",
    "has", "have", "how", "i", "in", "introduce", "is", "it", "me", "of", "on", "or", "overview",
    "please", "question", "questions", "should", "some", "something", "tell", "that", "the",
    "their", "them", "these", "they", "this", "to", "us", "use", "using", "was", "were", "what",
    "when", "where", "which", "who", "why", "will", "with", "work", "works", "would", "you", "your",
})
_CHINESE_STOP = re.compile("|".join(sorted(("请介绍一下", "请问一下", "介绍一下", "解释一下", "说一下", "讲一下", "请介绍", "请说明", "请解释", "能不能", "可不可以", "有什么", "为什么", "什么是", "怎么样", "你认为", "请问", "能否", "可以", "如何", "怎么", "怎样", "什么", "一下", "介绍", "说明", "解释", "谈谈", "说说", "请你", "简单", "简要", "详细", "这个", "这些", "问题"), key=len, reverse=True)))


def tokens(text: str) -> set[str]:
    result: set[str] = set()
    for match in _TOKEN.finditer(_CHINESE_STOP.sub(" ", text.lower())):
        token = match.group()
        if "一" <= token[0] <= "鿿":
            result.update(token[index:index + 2] for index in range(len(token) - 1))
        elif token not in _ENGLISH_STOP and (len(token) > 1 or token in {"c", "r"}):
            result.add(token)
    return result


def index_tokens(text: str) -> str:
    return " ".join(token.encode("utf-8").hex() for token in sorted(tokens(text)))
