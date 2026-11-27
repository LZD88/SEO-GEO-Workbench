ALTER TABLE yaosight.projects ADD COLUMN paused_at timestamptz;
CREATE TABLE yaosight.workspace_limits (
    workspace_id uuid PRIMARY KEY REFERENCES yaosight.workspaces ON DELETE CASCADE,
    model_limit integer NOT NULL DEFAULT 200 CHECK (model_limit >= 0),
    page_limit integer NOT NULL DEFAULT 1000 CHECK (page_limit >= 0),
    source_limit integer NOT NULL DEFAULT 100 CHECK (source_limit >= 0),
    max_active integer NOT NULL DEFAULT 4 CHECK (max_active > 0)
);

CREATE TABLE yaosight.paused_channels (
    id text PRIMARY KEY,
    paused_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE yaosight.jobs (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('geo','seo','article-source','article-optimization')),
    request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 1 AND 150),
    input jsonb NOT NULL,
    status text NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','running','partial','succeeded','failed','canceled','review')),
    baseline_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    first_claimed_at timestamptz,
    ready_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    cancel_requested_at timestamptz,
    lease_token uuid,
    leased_until timestamptz,
    PRIMARY KEY (workspace_id, project_id, id),
    UNIQUE (workspace_id, project_id, kind, request_key),
    FOREIGN KEY (workspace_id, project_id) REFERENCES yaosight.projects ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, project_id, baseline_id) REFERENCES yaosight.jobs (workspace_id, project_id, id)
);
CREATE INDEX jobs_claim_queue ON yaosight.jobs (ready_at, created_at) WHERE status IN ('queued','running');
CREATE INDEX jobs_project_history ON yaosight.jobs (workspace_id, project_id, created_at DESC, id DESC);

CREATE TABLE yaosight.job_steps (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    job_id uuid NOT NULL,
    step_index integer NOT NULL CHECK (step_index >= 0),
    channel text,
    input jsonb NOT NULL,
    category text NOT NULL CHECK (category IN ('model_limit','page_limit','source_limit')),
    estimated_units integer NOT NULL CHECK (estimated_units >= 0),
    actual_units integer CHECK (actual_units BETWEEN 0 AND estimated_units),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','review','canceled')),
    attempts integer NOT NULL DEFAULT 0,
    ready_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    error_category text,
    result jsonb,
    PRIMARY KEY (workspace_id, project_id, job_id, step_index),
    FOREIGN KEY (workspace_id, project_id, job_id) REFERENCES yaosight.jobs ON DELETE CASCADE
);
CREATE INDEX job_steps_usage ON yaosight.job_steps (workspace_id, category, state);
