from __future__ import annotations

from datetime import UTC, datetime
from enum import Enum
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator


def new_id() -> str:
    return str(uuid4())


def _not_blank(value: str, label: str) -> str:
    if not value.strip():
        raise ValueError(f"{label} must not be blank")
    return value


class InterviewStatus(str, Enum):
    created = "CREATED"
    in_progress = "IN_PROGRESS"
    finished = "FINISHED"
    scoring = "SCORING"
    reported = "REPORTED"


class CompetencyItem(BaseModel):
    name: str
    description: str
    probe_patterns: list[str] = Field(default_factory=list)
    weight: float = Field(default=0.0, allow_inf_nan=False)

    @field_validator("name", "description")
    @classmethod
    def text_fields_are_not_blank(cls, value: str) -> str:
        return _not_blank(value, "competency text")

    @field_validator("probe_patterns")
    @classmethod
    def probe_patterns_are_not_blank(cls, value: list[str]) -> list[str]:
        if any(not pattern.strip() for pattern in value):
            raise ValueError("probe patterns must not contain blank text")
        return value


class CompetencyModel(BaseModel):
    job_id: str
    job_title: str
    items: list[CompetencyItem]

    @field_validator("job_id")
    @classmethod
    def job_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "job_id")

    @field_validator("job_title")
    @classmethod
    def job_title_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "job_title")

    @field_validator("items")
    @classmethod
    def has_items(cls, value: list[CompetencyItem]) -> list[CompetencyItem]:
        if not value:
            raise ValueError("competency model must include at least one item")
        return value

    @model_validator(mode="after")
    def item_names_are_unique(self) -> "CompetencyModel":
        names = [item.name.strip() for item in self.items]
        if len(names) != len(set(names)):
            raise ValueError("competency model items must not contain duplicate names")
        return self


class ProbePatternHit(BaseModel):
    job_id: str
    competency: str
    pattern: str
    score: float = Field(ge=0.0, allow_inf_nan=False)

    @field_validator("job_id")
    @classmethod
    def job_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "job_id")

    @field_validator("competency", "pattern")
    @classmethod
    def text_fields_are_not_blank(cls, value: str) -> str:
        return _not_blank(value, "probe pattern hit text")


class TranscriptSegment(BaseModel):
    session_id: str
    speaker: Literal["interviewer", "candidate", "unknown"]
    text: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    is_final: bool
    confidence: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def timestamps_are_monotonic(self) -> "TranscriptSegment":
        if self.end_ms < self.start_ms:
            raise ValueError("end_ms must be greater than or equal to start_ms")
        return self

    @field_validator("session_id", "text")
    @classmethod
    def required_text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"transcript segment {info.field_name}")


class Utterance(BaseModel):
    """一个说话人的一段连续发言，由一个或多个 final ASR 句子合并而成。"""

    utterance_id: str = Field(default_factory=new_id)
    speaker: Literal["interviewer", "candidate", "unknown"]
    text: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    sentence_count: int = Field(ge=1)

    @model_validator(mode="after")
    def timestamps_are_monotonic(self) -> "Utterance":
        if self.end_ms < self.start_ms:
            raise ValueError("utterance end_ms must be greater than or equal to start_ms")
        return self

    @field_validator("utterance_id", "text")
    @classmethod
    def required_text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"utterance {info.field_name}")


class ConsistencyFlag(BaseModel):
    turn_id_a: str
    turn_id_b: str
    description: str
    severity: Literal["low", "high"]

    @field_validator("turn_id_a", "turn_id_b")
    @classmethod
    def turn_ids_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, info.field_name)

    @field_validator("description")
    @classmethod
    def description_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "description")

    @model_validator(mode="after")
    def turn_ids_are_distinct(self) -> "ConsistencyFlag":
        if self.turn_id_a == self.turn_id_b:
            raise ValueError("consistency flag turn ids must be distinct")
        return self


class FactClaim(BaseModel):
    turn_id: str
    contribution_scope: Literal["solo", "lead", "participant", "team", "unknown"] = "unknown"
    responsibilities: list[str] = Field(default_factory=list)
    technologies: list[str] = Field(default_factory=list)
    metrics: list[str] = Field(default_factory=list)

    @field_validator("turn_id")
    @classmethod
    def turn_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "turn_id")

    @field_validator("responsibilities", "technologies", "metrics")
    @classmethod
    def fact_items_are_not_blank(cls, value: list[str], info: ValidationInfo) -> list[str]:
        if any(not item.strip() for item in value):
            raise ValueError(f"fact claim {info.field_name} must not contain blank text")
        return value


class ChainLink(BaseModel):
    """追问链上的一环：一次追问与对应回答。"""

    probe_question: str
    probe_target: str
    answer_turn_id: str
    credibility_after: Literal["solid", "vague", "suspicious"]

    @field_validator("probe_question", "probe_target", "answer_turn_id")
    @classmethod
    def text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"chain link {info.field_name}")


class ProbeChain(BaseModel):
    """围绕一个主题或声明的下钻追问链。"""

    chain_id: str = Field(default_factory=new_id)
    interview_id: str
    topic: str
    origin: Literal["resume_claim", "answer_claim", "competency_gap"]
    resume_claim_ref: str | None = None
    links: list[ChainLink] = Field(default_factory=list)
    verdict: Literal["held_up", "cracked", "unresolved"] = "unresolved"
    crack_depth: int | None = Field(default=None, ge=1)

    @field_validator("chain_id", "interview_id", "topic")
    @classmethod
    def text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"probe chain {info.field_name}")

    @field_validator("resume_claim_ref")
    @classmethod
    def resume_claim_ref_is_not_blank(cls, value: str | None) -> str | None:
        if value is not None:
            return _not_blank(value, "resume_claim_ref")
        return value

    @model_validator(mode="after")
    def verdict_matches_crack_depth(self) -> "ProbeChain":
        if self.verdict == "cracked" and self.crack_depth is None:
            raise ValueError("cracked probe chains must include crack_depth")
        if self.verdict != "cracked" and self.crack_depth is not None:
            raise ValueError("only cracked probe chains may include crack_depth")
        return self


class QATurn(BaseModel):
    turn_id: str = Field(default_factory=new_id)
    question: str
    question_source: Literal["interviewer", "ai_probe"] = "interviewer"
    answer: str
    answer_start_ms: int = Field(default=0, ge=0)
    answer_end_ms: int = Field(default=0, ge=0)
    probe_target: str | None = None
    question_utterance_id: str | None = None
    answer_utterance_id: str | None = None
    probe_chain_id: str | None = None
    asked_option_id: str | None = None
    question_origin: Literal["system_suggested", "interviewer_custom"] | None = None

    @model_validator(mode="after")
    def answer_timestamps_are_monotonic(self) -> "QATurn":
        if self.answer_end_ms < self.answer_start_ms:
            raise ValueError("answer_end_ms must be greater than or equal to answer_start_ms")
        return self

    @model_validator(mode="after")
    def probe_target_matches_question_source(self) -> "QATurn":
        if self.probe_target is not None and not self.probe_target.strip():
            raise ValueError("probe_target must not be blank")
        if self.question_source == "ai_probe" and not self.probe_target:
            raise ValueError("ai_probe turns must include probe_target")
        return self

    @field_validator("turn_id")
    @classmethod
    def turn_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "turn_id")

    @field_validator(
        "question_utterance_id",
        "answer_utterance_id",
        "probe_chain_id",
        "asked_option_id",
    )
    @classmethod
    def utterance_ids_are_not_blank(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is not None:
            return _not_blank(value, info.field_name)
        return value

    @field_validator("question", "answer")
    @classmethod
    def text_fields_are_not_blank(cls, value: str) -> str:
        return _not_blank(value, "question and answer")


class InterviewContext(BaseModel):
    session_id: str
    job_id: str
    candidate_id: str
    competency_model: CompetencyModel
    candidate_name: str = ""
    interview_seq: int = Field(default=0, ge=0)
    candidate_resume_text: str = ""
    utterances: list[Utterance] = Field(default_factory=list)
    turns: list[QATurn] = Field(default_factory=list)
    probe_chains: list[ProbeChain] = Field(default_factory=list)
    started_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    ended_at: datetime | None = None
    fact_claims: list[FactClaim] = Field(default_factory=list)
    flags: list[ConsistencyFlag] = Field(default_factory=list)
    question_steering: Literal["balanced", "resume_drill", "jd_professional"] = "balanced"
    steering_history: list[Literal["balanced", "resume_drill", "jd_professional"]] = Field(
        default_factory=list
    )
    suggested_question_keys: list[str] = Field(default_factory=list)

    @field_validator("session_id", "job_id", "candidate_id")
    @classmethod
    def identifiers_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"interview context {info.field_name}")

    @model_validator(mode="after")
    def turn_ids_are_unique(self) -> "InterviewContext":
        turn_ids = [turn.turn_id for turn in self.turns]
        if len(turn_ids) != len(set(turn_ids)):
            raise ValueError("interview context turns must not contain duplicate turn_id values")
        return self

    @model_validator(mode="after")
    def utterance_ids_are_unique(self) -> "InterviewContext":
        utterance_ids = [utterance.utterance_id for utterance in self.utterances]
        if len(utterance_ids) != len(set(utterance_ids)):
            raise ValueError("interview context utterances must not contain duplicate utterance_id values")
        return self

    @field_validator("suggested_question_keys")
    @classmethod
    def suggested_question_keys_are_not_blank(cls, value: list[str]) -> list[str]:
        for item in value:
            _not_blank(item, "suggested question key")
        return value

    @model_validator(mode="after")
    def probe_chain_ids_are_unique(self) -> "InterviewContext":
        chain_ids = [chain.chain_id for chain in self.probe_chains]
        if len(chain_ids) != len(set(chain_ids)):
            raise ValueError("interview context probe_chains must not contain duplicate chain_id values")
        chain_id_set = set(chain_ids)
        for chain in self.probe_chains:
            if chain.interview_id != self.session_id:
                raise ValueError("probe chain interview_id must match interview context session_id")
        for turn in self.turns:
            if turn.probe_chain_id and turn.probe_chain_id not in chain_id_set:
                raise ValueError(f"QATurn references unknown probe_chain_id: {turn.probe_chain_id}")
        return self

    @model_validator(mode="after")
    def turns_reference_known_utterances(self) -> "InterviewContext":
        utterance_ids = {utterance.utterance_id for utterance in self.utterances}
        for turn in self.turns:
            if turn.question_utterance_id and turn.question_utterance_id not in utterance_ids:
                raise ValueError(
                    f"QATurn question references unknown utterance_id: {turn.question_utterance_id}"
                )
            if turn.answer_utterance_id and turn.answer_utterance_id not in utterance_ids:
                raise ValueError(
                    f"QATurn answer references unknown utterance_id: {turn.answer_utterance_id}"
                )
        return self

    @model_validator(mode="after")
    def fact_claims_and_flags_reference_known_turns(self) -> "InterviewContext":
        turn_ids = {turn.turn_id for turn in self.turns}
        for claim in self.fact_claims:
            if claim.turn_id not in turn_ids:
                raise ValueError(f"fact claim references unknown turn_id: {claim.turn_id}")
        for flag in self.flags:
            if flag.turn_id_a not in turn_ids:
                raise ValueError(f"consistency flag references unknown turn_id: {flag.turn_id_a}")
            if flag.turn_id_b not in turn_ids:
                raise ValueError(f"consistency flag references unknown turn_id: {flag.turn_id_b}")
        for chain in self.probe_chains:
            for link in chain.links:
                if link.answer_turn_id not in turn_ids:
                    raise ValueError(
                        f"probe chain link references unknown turn_id: {link.answer_turn_id}"
                    )
        return self

    @model_validator(mode="after")
    def ended_at_is_not_before_started_at(self) -> "InterviewContext":
        if self.ended_at is not None:
            try:
                ended_before_started = self.ended_at < self.started_at
            except TypeError as exc:
                raise ValueError("interview context ended_at must be comparable to started_at") from exc
            if ended_before_started:
                raise ValueError("interview context ended_at must be greater than or equal to started_at")
        return self


class ExamSolution(BaseModel):
    question_summary: str
    key_points: list[str] = Field(min_length=1, max_length=8)
    reference_answer: str
    pitfalls: list[str] = Field(default_factory=list, max_length=5)
    source: Literal["vision", "ocr_text"] = "vision"
    used_fallback: bool = False
    extracted_text: str = ""
    warning: str = ""

    @field_validator("question_summary", "reference_answer")
    @classmethod
    def exam_text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"exam solution {info.field_name}")

    @field_validator("key_points", "pitfalls")
    @classmethod
    def exam_list_items_are_not_blank(cls, value: list[str], info: ValidationInfo) -> list[str]:
        for item in value:
            _not_blank(item, f"exam solution {info.field_name} item")
        return value


class MemoryHit(BaseModel):
    memory_id: str
    kind: Literal["project", "candidate_profile", "probe_playbook", "job_insight"]
    subject: str
    summary: str
    detail: str = ""
    score: float = Field(ge=0.0, le=1.0)
    origin: str = ""

    @field_validator("memory_id", "subject", "summary")
    @classmethod
    def memory_text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"memory hit {info.field_name}")


class DistilledMemoryItem(BaseModel):
    kind: Literal["candidate_profile", "probe_playbook", "job_insight"]
    subject_key: str
    summary: str
    detail: str = ""

    @field_validator("subject_key", "summary")
    @classmethod
    def distilled_text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"distilled memory {info.field_name}")


class DistilledMemory(BaseModel):
    items: list[DistilledMemoryItem] = Field(default_factory=list, max_length=8)


class MemoryReviewItem(BaseModel):
    turn_id: str
    memory_subject: str
    verdict: Literal["supported", "conflicted", "unverified"]
    note: str

    @field_validator("turn_id", "memory_subject", "note")
    @classmethod
    def review_text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"memory review {info.field_name}")


class ResumeClaim(BaseModel):
    claim_id: str = Field(default_factory=new_id)
    text: str
    tags: list[str] = Field(default_factory=list)

    @field_validator("claim_id", "text")
    @classmethod
    def text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"resume claim {info.field_name}")

    @field_validator("tags")
    @classmethod
    def tags_are_not_blank(cls, value: list[str]) -> list[str]:
        if any(not item.strip() for item in value):
            raise ValueError("resume claim tags must not contain blank text")
        return value


class ProbeRequest(BaseModel):
    job_id: str
    competency_model: CompetencyModel
    recent_turns: list[QATurn]
    latest_answer: str
    resume_claims: list[ResumeClaim] = Field(default_factory=list)
    probe_chains: list[ProbeChain] = Field(default_factory=list)
    memory_hits: list[MemoryHit] = Field(default_factory=list)

    @field_validator("job_id")
    @classmethod
    def job_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "job_id")

    @field_validator("latest_answer")
    @classmethod
    def latest_answer_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "latest_answer")

    @model_validator(mode="after")
    def recent_turn_ids_are_unique(self) -> "ProbeRequest":
        turn_ids = [turn.turn_id for turn in self.recent_turns]
        if len(turn_ids) != len(set(turn_ids)):
            raise ValueError("probe request recent_turns must not contain duplicate turn_id values")
        claim_ids = [claim.claim_id for claim in self.resume_claims]
        if len(claim_ids) != len(set(claim_ids)):
            raise ValueError("probe request resume_claims must not contain duplicate claim_id values")
        return self


class ProbeSuggestion(BaseModel):
    question: str
    target: str
    competency: str
    priority: int = Field(ge=1, le=3)
    chain_id: str | None = None
    chain_label: str | None = None

    @field_validator("question", "target", "competency", "chain_id", "chain_label")
    @classmethod
    def text_fields_are_not_blank(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _not_blank(value, "probe suggestion text")


class CredibilitySignal(BaseModel):
    level: Literal["solid", "vague", "suspicious"]
    reason: str
    drill_down_hint: str

    @field_validator("reason", "drill_down_hint")
    @classmethod
    def text_fields_are_not_blank(cls, value: str) -> str:
        return _not_blank(value, "credibility text")


class ProbeResponse(BaseModel):
    suggestions: list[ProbeSuggestion] = Field(min_length=1, max_length=3)
    credibility: CredibilitySignal


class EvidenceRef(BaseModel):
    turn_id: str
    quote_start_ms: int = Field(ge=0)
    quote_end_ms: int = Field(ge=0)
    excerpt: str

    @model_validator(mode="after")
    def quote_timestamps_are_monotonic(self) -> "EvidenceRef":
        if self.quote_end_ms < self.quote_start_ms:
            raise ValueError("quote_end_ms must be greater than or equal to quote_start_ms")
        return self

    @field_validator("turn_id")
    @classmethod
    def turn_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "turn_id")

    @field_validator("excerpt")
    @classmethod
    def excerpt_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "excerpt")


class DimensionScore(BaseModel):
    dimension: str
    score: float = Field(ge=0.0, le=100.0)
    weight: float = Field(allow_inf_nan=False)
    evidence: list[EvidenceRef] = Field(min_length=1)

    @field_validator("dimension")
    @classmethod
    def dimension_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "dimension")


class InterviewScore(BaseModel):
    session_id: str
    dimensions: list[DimensionScore] = Field(min_length=1)
    total_score: float = Field(ge=0.0, le=100.0)
    risk_notes: list[str] = Field(default_factory=list)
    recommendation: Literal["strong_yes", "yes", "hold", "no"]
    analysis_mode: Literal["llm", "fallback"] = "llm"

    @field_validator("session_id")
    @classmethod
    def session_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "session_id")

    @field_validator("risk_notes")
    @classmethod
    def risk_notes_are_not_blank(cls, value: list[str]) -> list[str]:
        for note in value:
            _not_blank(note, "risk note")
        return value

    @model_validator(mode="after")
    def dimension_names_are_unique(self) -> "InterviewScore":
        names = [dimension.dimension.strip() for dimension in self.dimensions]
        if len(names) != len(set(names)):
            raise ValueError("interview score dimensions must not contain duplicate names")
        return self


class AIGCResult(BaseModel):
    turn_id: str
    ai_generated_prob: float = Field(ge=0.0, le=1.0)
    template_similarity: float = Field(ge=0.0, le=1.0)
    rehearsal_score: float = Field(default=0.0, ge=0.0, le=1.0)
    mode: Literal["voice", "written"] = "voice"
    matched_template: str | None = None
    flagged: bool = False
    llm_reason: str | None = None

    @field_validator("turn_id")
    @classmethod
    def turn_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "turn_id")

    @field_validator("matched_template")
    @classmethod
    def matched_template_is_not_blank(cls, value: str | None) -> str | None:
        if value is not None:
            return _not_blank(value, "matched_template")
        return value


def _validate_aigc_results_cover_turns(
    context: "InterviewContext",
    aigc_results: list[AIGCResult],
) -> None:
    _validate_aigc_results_cover_turn_ids({turn.turn_id for turn in context.turns}, aigc_results)


def _validate_aigc_results_cover_turn_ids(
    expected: set[str],
    aigc_results: list[AIGCResult],
) -> None:
    result_ids = [item.turn_id for item in aigc_results]
    duplicates = {turn_id for turn_id in result_ids if result_ids.count(turn_id) > 1}
    if duplicates:
        raise ValueError("AIGC results must not contain duplicate turn_id values")
    unknown = set(result_ids) - expected
    if unknown:
        raise ValueError(f"AIGC result references unknown turn_id: {sorted(unknown)[0]}")
    missing = expected - set(result_ids)
    if missing:
        raise ValueError("AIGC results must cover every transcript turn")


class BehaviorSignal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    turn_id: str
    fluency: float = Field(ge=0.0, le=1.0)
    hesitation: float = Field(ge=0.0, le=1.0)
    evasiveness_hint: bool

    @field_validator("turn_id")
    @classmethod
    def turn_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "turn_id")


class JobCreate(BaseModel):
    title: str
    jd_text: str

    @field_validator("title", "jd_text")
    @classmethod
    def text_fields_are_not_blank(cls, value: str) -> str:
        return _not_blank(value, "job text")


class JobRecord(BaseModel):
    id: str = Field(default_factory=new_id)
    title: str
    jd_text: str
    competency_model: CompetencyModel
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("title", "jd_text")
    @classmethod
    def text_fields_are_not_blank(cls, value: str) -> str:
        return _not_blank(value, "job text")

    @field_validator("id")
    @classmethod
    def id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "job id")

    @model_validator(mode="after")
    def competency_model_matches_job(self) -> "JobRecord":
        if self.competency_model.job_id != self.id:
            raise ValueError("job competency_model.job_id must match job id")
        return self


class CandidateCreate(BaseModel):
    name: str
    resume_text: str = ""

    @field_validator("name")
    @classmethod
    def name_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "candidate name")


class CandidateRecord(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
    resume_text: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("name")
    @classmethod
    def name_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "candidate name")

    @field_validator("id")
    @classmethod
    def id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "candidate id")


class SetupExtraction(BaseModel):
    job_title: str
    candidate_name: str

    @field_validator("job_title", "candidate_name")
    @classmethod
    def text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"setup extraction {info.field_name}")


class QuestionBankItem(BaseModel):
    question_id: str = Field(default_factory=new_id)
    category: Literal["technical", "project", "experience", "job_match", "behavior"]
    question: str
    basis: Literal["jd", "resume", "jd_resume"]
    basis_excerpt: str
    competency: str
    asked: bool = False

    @field_validator("question_id", "question", "basis_excerpt", "competency")
    @classmethod
    def text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"question bank item {info.field_name}")


class QuestionBank(BaseModel):
    interview_id: str
    items: list[QuestionBankItem] = Field(min_length=8, max_length=20)

    @field_validator("interview_id")
    @classmethod
    def interview_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "question bank interview_id")

    @model_validator(mode="after")
    def question_ids_are_unique(self) -> "QuestionBank":
        question_ids = [item.question_id for item in self.items]
        if len(question_ids) != len(set(question_ids)):
            raise ValueError("question bank items must not contain duplicate question_id values")
        return self


class NextOption(BaseModel):
    option_id: str = Field(default_factory=new_id)
    kind: Literal["follow_up", "bank", "generated"]
    question: str
    reason: str
    category: str | None = None
    chain_id: str | None = None
    bank_question_id: str | None = None

    @field_validator("option_id", "question", "reason")
    @classmethod
    def text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"next option {info.field_name}")

    @field_validator("category", "chain_id", "bank_question_id")
    @classmethod
    def optional_text_fields_are_not_blank(
        cls, value: str | None, info: ValidationInfo
    ) -> str | None:
        if value is not None:
            return _not_blank(value, f"next option {info.field_name}")
        return value


class NextOptions(BaseModel):
    interview_id: str
    after_turn_id: str | None = None
    follow_up: list[NextOption] = Field(min_length=1, max_length=2)
    alternatives: list[NextOption] = Field(min_length=2, max_length=3)

    @field_validator("interview_id")
    @classmethod
    def interview_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "next options interview_id")

    @field_validator("after_turn_id")
    @classmethod
    def after_turn_id_is_not_blank(cls, value: str | None) -> str | None:
        if value is not None:
            return _not_blank(value, "next options after_turn_id")
        return value

    @model_validator(mode="after")
    def option_ids_are_unique(self) -> "NextOptions":
        option_ids = [option.option_id for option in [*self.follow_up, *self.alternatives]]
        if len(option_ids) != len(set(option_ids)):
            raise ValueError("next options must not contain duplicate option_id values")
        return self


class QuickSetupRequest(BaseModel):
    jd_text: str
    resume_text: str

    @field_validator("jd_text", "resume_text")
    @classmethod
    def text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"quick setup {info.field_name}")


class QuickSetupResponse(BaseModel):
    interview_id: str
    job_id: str
    job_title: str
    candidate_id: str
    candidate_name: str
    extraction_confident: bool
    question_bank: QuestionBank | None = None

    @field_validator("interview_id", "job_id", "job_title", "candidate_id", "candidate_name")
    @classmethod
    def text_fields_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, f"quick setup response {info.field_name}")


class ConsentCreate(BaseModel):
    candidate_id: str
    consent_type: Literal["behavior_signal", "long_term_memory"] = "behavior_signal"
    granted: bool = True

    @field_validator("candidate_id")
    @classmethod
    def candidate_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "candidate_id")


class ConsentRecord(BaseModel):
    id: str = Field(default_factory=new_id)
    candidate_id: str
    consent_type: Literal["behavior_signal", "long_term_memory"] = "behavior_signal"
    granted: bool = True
    granted_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    revoked_at: datetime | None = None

    @field_validator("id", "candidate_id")
    @classmethod
    def identifiers_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, info.field_name)

    @model_validator(mode="after")
    def revocation_time_is_not_before_grant(self) -> "ConsentRecord":
        if self.revoked_at is not None:
            try:
                revoked_before_granted = self.revoked_at < self.granted_at
            except TypeError as exc:
                raise ValueError("revoked_at must be comparable to granted_at") from exc
            if revoked_before_granted:
                raise ValueError("revoked_at must be greater than or equal to granted_at")
        return self


class InterviewCreate(BaseModel):
    job_id: str
    candidate_id: str
    signal_enabled: bool = False

    @field_validator("job_id", "candidate_id")
    @classmethod
    def identifiers_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, info.field_name)


class InterviewRecord(BaseModel):
    id: str = Field(default_factory=new_id)
    job_id: str
    candidate_id: str
    status: InterviewStatus = InterviewStatus.created
    context: InterviewContext
    signal_enabled: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    ended_at: datetime | None = None

    @field_validator("id", "job_id", "candidate_id")
    @classmethod
    def identifiers_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, info.field_name)

    @model_validator(mode="after")
    def context_identifiers_match_record(self) -> "InterviewRecord":
        if self.context.session_id != self.id:
            raise ValueError("interview context session_id must match interview id")
        if self.context.job_id != self.job_id:
            raise ValueError("interview context job_id must match interview job_id")
        if self.context.candidate_id != self.candidate_id:
            raise ValueError("interview context candidate_id must match interview candidate_id")
        return self

    @model_validator(mode="after")
    def ended_at_is_not_before_started_at(self) -> "InterviewRecord":
        if self.started_at is not None and self.ended_at is not None:
            try:
                ended_before_started = self.ended_at < self.started_at
            except TypeError as exc:
                raise ValueError("interview ended_at must be comparable to started_at") from exc
            if ended_before_started:
                raise ValueError("interview ended_at must be greater than or equal to started_at")
        return self

    @model_validator(mode="after")
    def timestamps_match_status(self) -> "InterviewRecord":
        if self.status == InterviewStatus.created:
            if self.started_at is not None or self.ended_at is not None:
                raise ValueError("CREATED interviews must not have started_at or ended_at")
        elif self.status == InterviewStatus.in_progress:
            if self.started_at is None:
                raise ValueError("IN_PROGRESS interviews must include started_at")
            if self.ended_at is not None:
                raise ValueError("IN_PROGRESS interviews must not include ended_at")
        elif self.started_at is None or self.ended_at is None:
            raise ValueError(f"{self.status.value} interviews must include started_at and ended_at")
        return self


class OfflineInterviewInput(BaseModel):
    job_title: str
    jd_text: str
    candidate_name: str
    resume_text: str = ""
    turns: list[QATurn] = Field(min_length=1)

    @field_validator("job_title", "jd_text", "candidate_name")
    @classmethod
    def text_fields_are_not_blank(cls, value: str) -> str:
        return _not_blank(value, "offline input text")

    @model_validator(mode="after")
    def turn_ids_are_unique(self) -> "OfflineInterviewInput":
        turn_ids = [turn.turn_id for turn in self.turns]
        if len(turn_ids) != len(set(turn_ids)):
            raise ValueError("offline interview turns must not contain duplicate turn_id values")
        return self


class AIGCDetectRequest(BaseModel):
    turns: list[QATurn] = Field(min_length=1)

    @model_validator(mode="after")
    def turn_ids_are_unique(self) -> "AIGCDetectRequest":
        turn_ids = [turn.turn_id for turn in self.turns]
        if len(turn_ids) != len(set(turn_ids)):
            raise ValueError("AIGC detection turns must not contain duplicate turn_id values")
        return self


class ScoringRequest(BaseModel):
    context: InterviewContext
    aigc_results: list[AIGCResult] = Field(min_length=1)

    @model_validator(mode="after")
    def aigc_results_cover_context_turns(self) -> "ScoringRequest":
        _validate_aigc_results_cover_turns(self.context, self.aigc_results)
        return self


class ReportBuildRequest(BaseModel):
    context: InterviewContext
    score: InterviewScore
    aigc_results: list[AIGCResult] = Field(min_length=1)

    @model_validator(mode="after")
    def aigc_results_cover_context_turns(self) -> "ReportBuildRequest":
        _validate_aigc_results_cover_turns(self.context, self.aigc_results)
        return self


class OfflineInterviewResult(BaseModel):
    job: JobRecord
    candidate: CandidateRecord
    interview: InterviewRecord
    report: "Report"


class OfflineTaskAccepted(BaseModel):
    interview_id: str
    task_id: str
    task_name: str
    status: Literal["queued"]
    message: str = "offline scoring task queued"

    @field_validator("interview_id", "task_id", "task_name")
    @classmethod
    def identifiers_are_not_blank(cls, value: str, info: ValidationInfo) -> str:
        return _not_blank(value, info.field_name)


class QuestionAdoptionStats(BaseModel):
    suggested_unique_count: int = Field(default=0, ge=0)
    adopted_suggested_count: int = Field(default=0, ge=0)
    custom_question_count: int = Field(default=0, ge=0)
    adoption_rate: float = Field(default=0.0, ge=0.0, le=1.0)
    steering_focus: Literal["balanced", "resume_drill", "jd_professional"] = "balanced"
    steering_history: list[Literal["balanced", "resume_drill", "jd_professional"]] = Field(
        default_factory=list
    )


class Report(BaseModel):
    interview_id: str
    score: InterviewScore
    analysis_mode: Literal["llm", "fallback"] = "llm"
    aigc_results: list[AIGCResult] = Field(min_length=1)
    consistency_flags: list[ConsistencyFlag]
    transcript: list[QATurn] = Field(min_length=1)
    utterances: list[Utterance] = Field(default_factory=list)
    probe_chains: list[ProbeChain] = Field(default_factory=list)
    candidate_resume_text: str = ""
    question_adoption: QuestionAdoptionStats = Field(default_factory=QuestionAdoptionStats)
    memory_review: list[MemoryReviewItem] = Field(default_factory=list)
    summary: str
    json_path: str | None = None
    html_path: str | None = None
    pdf_path: str | None = None
    transcript_path: str | None = None
    artifact_uris: dict[str, str] = Field(default_factory=dict)
    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("interview_id")
    @classmethod
    def interview_id_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "interview_id")

    @field_validator("summary")
    @classmethod
    def summary_is_not_blank(cls, value: str) -> str:
        return _not_blank(value, "summary")

    @field_validator("json_path", "html_path", "pdf_path", "transcript_path")
    @classmethod
    def artifact_paths_are_not_blank(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is not None:
            return _not_blank(value, info.field_name)
        return value

    @field_validator("artifact_uris")
    @classmethod
    def artifact_uris_are_not_blank(cls, value: dict[str, str]) -> dict[str, str]:
        for name, uri in value.items():
            _not_blank(name, "artifact uri key")
            _not_blank(uri, "artifact uri value")
        return value

    @model_validator(mode="after")
    def interview_id_matches_score_session(self) -> "Report":
        if self.interview_id != self.score.session_id:
            raise ValueError("report interview_id must match score session_id")
        if self.analysis_mode != self.score.analysis_mode:
            raise ValueError("report analysis_mode must match score analysis_mode")
        return self

    @model_validator(mode="after")
    def references_match_transcript_turns(self) -> "Report":
        turn_ids = [turn.turn_id for turn in self.transcript]
        if len(turn_ids) != len(set(turn_ids)):
            raise ValueError("report transcript must not contain duplicate turn_id values")
        utterance_ids = [utterance.utterance_id for utterance in self.utterances]
        if len(utterance_ids) != len(set(utterance_ids)):
            raise ValueError("report utterances must not contain duplicate utterance_id values")
        utterance_id_set = set(utterance_ids)
        transcript_turn_ids = set(turn_ids)
        for turn in self.transcript:
            if turn.question_utterance_id and turn.question_utterance_id not in utterance_id_set:
                raise ValueError(
                    f"report transcript question references unknown utterance_id: {turn.question_utterance_id}"
                )
            if turn.answer_utterance_id and turn.answer_utterance_id not in utterance_id_set:
                raise ValueError(
                    f"report transcript answer references unknown utterance_id: {turn.answer_utterance_id}"
                )
        for dimension in self.score.dimensions:
            for evidence in dimension.evidence:
                if evidence.turn_id not in transcript_turn_ids:
                    raise ValueError(f"report score evidence references unknown turn_id: {evidence.turn_id}")
        for flag in self.consistency_flags:
            if flag.turn_id_a not in transcript_turn_ids:
                raise ValueError(f"report consistency flag references unknown turn_id: {flag.turn_id_a}")
            if flag.turn_id_b not in transcript_turn_ids:
                raise ValueError(f"report consistency flag references unknown turn_id: {flag.turn_id_b}")
        chain_ids = [chain.chain_id for chain in self.probe_chains]
        if len(chain_ids) != len(set(chain_ids)):
            raise ValueError("report probe_chains must not contain duplicate chain_id values")
        for chain in self.probe_chains:
            if chain.interview_id != self.interview_id:
                raise ValueError("report probe chain interview_id must match report interview_id")
            for link in chain.links:
                if link.answer_turn_id not in transcript_turn_ids:
                    raise ValueError(
                        f"report probe chain link references unknown turn_id: {link.answer_turn_id}"
                    )
        report_chain_ids = {chain.chain_id for chain in self.probe_chains}
        for turn in self.transcript:
            if turn.probe_chain_id and turn.probe_chain_id not in report_chain_ids:
                raise ValueError(f"report transcript references unknown probe_chain_id: {turn.probe_chain_id}")
        _validate_aigc_results_cover_turn_ids(transcript_turn_ids, self.aigc_results)
        return self


_HOTKEY_TOKENS = {
    "CommandOrControl",
    "Command",
    "Control",
    "Ctrl",
    "Alt",
    "Option",
    "Shift",
    "Super",
    "Meta",
    "Plus",
    "Space",
    "Tab",
    "Enter",
    "Return",
    "Escape",
    "Esc",
    "Backspace",
    "Delete",
    "Up",
    "Down",
    "Left",
    "Right",
    # 标点键：Electron 全局快捷键按字面量注册，Gank 的翻页/滚动/透明度/缩放
    # 就是 ⌘, ⌘. ⌘; ⌘' ⌘[ ⌘] ⌘- ⌘0 ⌘=。
    ",",
    ".",
    ";",
    "'",
    "[",
    "]",
    "-",
    "=",
    "0",
}


def _valid_accelerator(value: str) -> str:
    parts = [part.strip() for part in str(value).split("+")]
    modifiers = {"CommandOrControl", "Command", "Control", "Ctrl", "Alt", "Option", "Shift", "Super", "Meta"}
    if len(parts) < 2:
        raise ValueError("hotkey must include a modifier and a key")
    if not any(part in modifiers for part in parts):
        raise ValueError("hotkey must include a modifier")
    if sum(part not in modifiers for part in parts) != 1 or len(set(parts)) != len(parts):
        raise ValueError("hotkey requires exactly one key and distinct modifiers")
    # 只有修饰键的弦（如 ⌘+,）会把所有 App 的「设置」抢走，直接拒绝。
    if not any(part in _HOTKEY_TOKENS or (len(part) == 1 and part.isalnum()) or (part.startswith("F") and part[1:].isdigit()) for part in parts if part not in modifiers):
        raise ValueError("hotkey must include a non-modifier key")
    for part in parts:
        if part in _HOTKEY_TOKENS:
            continue
        if part.startswith("F") and part[1:].isdigit() and 1 <= int(part[1:]) <= 24:
            continue
        if len(part) == 1 and part.isalnum():
            continue
        raise ValueError(f"unsupported hotkey token: {part}")
    return "+".join(parts)


class UiHotkeys(BaseModel):
    # 保持与 desktop/main/hotkeys.js、web/modules/shortcuts.js 一致。
    # 桌面端每次拉 /api/ui/settings 都会用这里的值覆盖本地默认值，
    # 三处不同步时改哪边都不生效。
    moveUp: str = "CommandOrControl+Up"
    moveDown: str = "CommandOrControl+Down"
    moveLeft: str = "CommandOrControl+Left"
    moveRight: str = "CommandOrControl+Right"

    captureRegion: str = "CommandOrControl+H"
    sendChat: str = "CommandOrControl+Enter"
    toggleWindow: str = "CommandOrControl+B"
    quitApp: str = "CommandOrControl+Q"
    newQuestion: str = "CommandOrControl+N"
    resetView: str = "CommandOrControl+R"
    deleteLastShot: str = "CommandOrControl+L"
    clearShots: str = "CommandOrControl+Shift+Backspace"

    toggleVisible: str = "CommandOrControl+Shift+Space"
    captureScreen: str = "CommandOrControl+Shift+Y"
    toggleCompact: str = "CommandOrControl+Shift+J"

    readPrev: str = "CommandOrControl+,"
    readNext: str = "CommandOrControl+."
    scrollUp: str = "CommandOrControl+;"
    scrollDown: str = "CommandOrControl+'"

    opacityDown: str = "CommandOrControl+["
    opacityUp: str = "CommandOrControl+]"
    zoomOut: str = "CommandOrControl+-"
    zoomReset: str = "CommandOrControl+0"
    zoomIn: str = "CommandOrControl+="

    @field_validator(
        "moveUp",
        "moveDown",
        "moveLeft",
        "moveRight",
        "toggleVisible",
        "toggleWindow",
        "quitApp",
        "toggleCompact",
        "captureRegion",
        "captureScreen",
        "sendChat",
        "newQuestion",
        "resetView",
        "deleteLastShot",
        "clearShots",
        "readPrev",
        "readNext",
        "scrollUp",
        "scrollDown",
        "opacityDown",
        "opacityUp",
        "zoomOut",
        "zoomReset",
        "zoomIn",
    )
    @classmethod
    def accelerator_is_supported(cls, value: str) -> str:
        return _valid_accelerator(value)

    def validate_unique(self) -> None:
        # Check both desktop platforms: CommandOrControl resolves differently on macOS.
        for primary in ("Command", "Control"):
            aliases = {
                "CommandOrControl": primary, "Ctrl": "Control", "Option": "Alt",
                "Super": "Command", "Meta": "Command", "Return": "Enter", "Esc": "Escape",
            }
            seen: set[tuple[str, ...]] = set()
            for value in self.model_dump().values():
                signature = tuple(sorted(aliases.get(part, part).upper() for part in value.split("+")))
                if signature in seen:
                    raise ValueError("快捷键不能重复，请为每项功能设置不同的组合键。")
                seen.add(signature)


class ChatHistoryTurn(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(default="", max_length=8000)


class ChatStreamRequest(BaseModel):
    text: str = Field(default="", max_length=8000)
    images: list[str] = Field(default_factory=list, max_length=8)
    history: list[ChatHistoryTurn] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def require_text_or_images(self) -> "ChatStreamRequest":
        if not self.text.strip() and not self.images:
            raise ValueError("chat requires text or images")
        return self


class UiSettings(BaseModel):
    answer_language: Literal["zh-CN", "en-US"] = "zh-CN"
    assistant_role: Literal["candidate", "interviewer"] = "candidate"
    study_specialty: str = Field(default="计算机 / 软件工程", max_length=120)
    study_language: str = Field(default="Python", max_length=80)
    study_goal: str = Field(default="看懂眼前这段代码或报错", max_length=1000)
    study_answer_style: Literal["hints", "walkthrough", "solution"] = "walkthrough"
    study_instructions: str = Field(default="", max_length=2000)
    jd_text: str = ""
    resume_text: str = ""
    long_term_memory_consent: bool = False
    hotkeys: UiHotkeys = Field(default_factory=UiHotkeys)
