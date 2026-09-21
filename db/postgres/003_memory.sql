CREATE TABLE IF NOT EXISTS project_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_path TEXT NOT NULL CHECK (btrim(repo_path) <> ''),
    repo_name TEXT NOT NULL CHECK (btrim(repo_name) <> ''),
    topic TEXT NOT NULL CHECK (btrim(topic) <> ''),
    fact TEXT NOT NULL CHECK (btrim(fact) <> ''),
    evidence TEXT NOT NULL DEFAULT '',
    embedding TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repo_path, topic)
);

CREATE TABLE IF NOT EXISTS interview_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('candidate_profile', 'probe_playbook', 'job_insight')),
    subject_key TEXT NOT NULL CHECK (btrim(subject_key) <> ''),
    candidate_id TEXT,
    job_id TEXT,
    summary TEXT NOT NULL CHECK (btrim(summary) <> ''),
    detail TEXT NOT NULL DEFAULT '',
    embedding TEXT NOT NULL,
    source_interview_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (kind, subject_key, source_interview_id)
);

CREATE INDEX IF NOT EXISTS idx_interview_memories_candidate
    ON interview_memories(candidate_id);

ALTER TABLE consents DROP CONSTRAINT IF EXISTS consents_consent_type_check;
ALTER TABLE consents ADD CONSTRAINT consents_consent_type_check
    CHECK (consent_type IN ('behavior_signal', 'long_term_memory'));
