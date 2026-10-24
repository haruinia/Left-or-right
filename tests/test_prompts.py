from __future__ import annotations

import pytest

from libs.common.prompts import load_prompt


def test_load_prompt_reads_prompt_file() -> None:
    prompt = load_prompt("probe_system.md")

    assert prompt.startswith("你是资深面试官教练")
    assert "严格 JSON" in prompt
    assert "resume_claims" in prompt
    assert "简历对质型追问" in prompt
    assert prompt == prompt.strip()


def test_load_question_bank_prompt_reads_prompt_file() -> None:
    prompt = load_prompt("question_bank.md")

    assert "结构化面试出题专家" in prompt
    assert "QuestionBank" in prompt
    assert "12–18" in prompt
    assert prompt == prompt.strip()


def test_load_next_options_prompt_reads_prompt_file() -> None:
    prompt = load_prompt("next_options.md")

    assert "实时面试问题编排助手" in prompt
    assert "NextOptions" in prompt
    assert "follow_up" in prompt
    assert "alternatives" in prompt
    assert prompt == prompt.strip()


def test_load_liuwa_chat_prompt_reads_prompt_file() -> None:
    prompt = load_prompt("liuwa_chat.md")

    assert prompt.startswith("你是一名解题助手")
    assert "## 解题思路" in prompt
    assert "{code_line}" in prompt
    assert "{answer_language}" in prompt
    assert "liuwa:type=choice" in prompt
    assert "## 代码" in prompt
    assert prompt == prompt.strip()


def test_load_prompt_rejects_path_separators() -> None:
    with pytest.raises(ValueError):
        load_prompt("../probe_system.md")


def test_load_prompt_raises_for_missing_file() -> None:
    with pytest.raises(FileNotFoundError):
        load_prompt("missing.md")
