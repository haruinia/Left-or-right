from __future__ import annotations

import subprocess
from collections import Counter
from pathlib import Path

from libs.common.config import get_settings

GIT_TIMEOUT_SECONDS = 30
README_CHARS = 2000
HARD_PROBLEM_KEYWORDS = (
    "性能",
    "优化",
    "死锁",
    "泄漏",
    "超时",
    "回滚",
    "重构",
    "故障",
    "race",
    "deadlock",
    "leak",
    "oom",
    "perf",
    "hotfix",
    "revert",
)
LANGUAGE_SUFFIXES = {
    ".py": "Python",
    ".js": "JavaScript",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".go": "Go",
    ".java": "Java",
    ".kt": "Kotlin",
    ".rs": "Rust",
    ".c": "C",
    ".cc": "C++",
    ".cpp": "C++",
    ".m": "Objective-C",
    ".swift": "Swift",
    ".rb": "Ruby",
    ".php": "PHP",
    ".sql": "SQL",
    ".sh": "Shell",
}
MARKER_FILES = {
    "pyproject.toml": "Python 打包",
    "requirements.txt": "Python 依赖",
    "package.json": "Node 工程",
    "go.mod": "Go module",
    "Cargo.toml": "Rust crate",
    "pom.xml": "Maven",
    "Dockerfile": "容器化部署",
    "docker-compose.yml": "Compose 编排",
}


class RepoFact:
    __slots__ = ("topic", "fact", "evidence")

    def __init__(self, topic: str, fact: str, evidence: str = "") -> None:
        self.topic = topic
        self.fact = fact
        self.evidence = evidence


def allowed_roots() -> list[Path]:
    raw = get_settings().memory_repo_roots
    roots: list[Path] = []
    for part in raw.split(","):
        candidate = part.strip()
        if candidate:
            roots.append(Path(candidate).expanduser().resolve())
    return roots


def resolve_repo_path(path: str) -> Path:
    roots = allowed_roots()
    if not roots:
        raise ValueError("MEMORY_REPO_ROOTS is not configured; refusing to scan arbitrary paths")
    resolved = Path(path).expanduser().resolve()
    if not any(resolved == root or root in resolved.parents for root in roots):
        raise ValueError(f"repo path is outside MEMORY_REPO_ROOTS: {resolved}")
    if not resolved.is_dir():
        raise ValueError(f"repo path is not a directory: {resolved}")
    return resolved


def _git(repo: Path, args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=GIT_TIMEOUT_SECONDS,
        check=True,
    )
    return result.stdout


def scan_repo(path: str) -> list[RepoFact]:
    repo = resolve_repo_path(path)
    try:
        toplevel = _git(repo, ["rev-parse", "--show-toplevel"]).strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as exc:
        raise ValueError(f"not a git repository: {repo}") from exc
    root = Path(toplevel)
    settings = get_settings()

    facts: list[RepoFact] = []
    files = [line.strip() for line in _git(root, ["ls-files"]).splitlines() if line.strip()]
    facts.extend(_tech_stack_facts(root, files))
    facts.extend(_structure_facts(files))
    facts.extend(_commit_facts(root, max_commits=settings.memory_repo_max_commits))
    readme = _readme_text(root, files)
    if readme:
        facts.append(RepoFact("项目简介", readme, evidence="README"))
    return facts


def _tech_stack_facts(root: Path, files: list[str]) -> list[RepoFact]:
    languages = Counter()
    for name in files:
        language = LANGUAGE_SUFFIXES.get(Path(name).suffix.lower())
        if language:
            languages[language] += 1
    facts: list[RepoFact] = []
    if languages:
        ranked = ", ".join(
            f"{language} {count} 文件" for language, count in languages.most_common(6)
        )
        facts.append(RepoFact("技术栈", f"主要语言分布：{ranked}。", evidence="git ls-files"))
    markers = [label for name, label in MARKER_FILES.items() if (root / name).is_file()]
    if markers:
        facts.append(
            RepoFact("工程化", "存在以下工程标记：" + "、".join(markers) + "。", evidence="仓库根目录")
        )
    return facts


def _structure_facts(files: list[str]) -> list[RepoFact]:
    top_dirs = Counter()
    for name in files:
        parts = Path(name).parts
        if len(parts) > 1:
            top_dirs[parts[0]] += 1
    if not top_dirs:
        return []
    ranked = ", ".join(f"{name}/({count})" for name, count in top_dirs.most_common(8))
    return [RepoFact("代码结构", f"顶层模块：{ranked}。", evidence="git ls-files")]


def _commit_facts(root: Path, *, max_commits: int) -> list[RepoFact]:
    output = _git(
        root,
        [
            "log",
            "--no-merges",
            f"-n{max_commits}",
            "--pretty=format:%h%x09%ad%x09%s",
            "--date=short",
        ],
    )
    rows = [line.split("\t") for line in output.splitlines() if line.strip()]
    if not rows:
        return []
    facts = [
        RepoFact(
            "提交活动",
            f"最近 {len(rows)} 个非合并提交，最新一条：{rows[0][2]}（{rows[0][1]}）。",
            evidence=f"git log -n{max_commits}",
        )
    ]
    hard: list[str] = []
    for row in rows:
        if len(row) < 3:
            continue
        subject = row[2]
        lowered = subject.lower()
        if any(keyword in subject or keyword in lowered for keyword in HARD_PROBLEM_KEYWORDS):
            hard.append(f"{row[0]} {subject}")
    if hard:
        facts.append(
            RepoFact(
                "疑难问题",
                "涉及性能/故障/重构的提交：" + "；".join(hard[:10]) + "。",
                evidence="git log 关键词匹配",
            )
        )
    return facts


def _readme_text(root: Path, files: list[str]) -> str:
    for name in files:
        if Path(name).name.lower().startswith("readme"):
            try:
                text = (root / name).read_text(encoding="utf-8", errors="ignore")
            except OSError:
                return ""
            return text.strip()[:README_CHARS]
    return ""
