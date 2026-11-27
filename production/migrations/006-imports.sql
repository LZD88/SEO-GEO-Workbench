CREATE TABLE yaosight.legacy_imports (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    job_id uuid NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, project_id, source_kind, source_id),
    FOREIGN KEY (workspace_id, project_id, job_id) REFERENCES yaosight.jobs (workspace_id, project_id, id)
);
