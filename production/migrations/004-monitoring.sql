CREATE TABLE yaosight.monitors (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('geo','seo')),
    cadence text NOT NULL CHECK (cadence IN ('daily','weekly')),
    time_zone text NOT NULL,
    current_version integer NOT NULL DEFAULT 1,
    active boolean NOT NULL DEFAULT false,
    next_run_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, project_id, id),
    FOREIGN KEY (workspace_id, project_id) REFERENCES yaosight.projects ON DELETE CASCADE
);
CREATE INDEX monitors_due ON yaosight.monitors (next_run_at) WHERE active;

CREATE TABLE yaosight.monitor_versions (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    monitor_id uuid NOT NULL,
    version integer NOT NULL,
    configuration jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, project_id, monitor_id, version),
    FOREIGN KEY (workspace_id, project_id, monitor_id) REFERENCES yaosight.monitors ON DELETE CASCADE
);

CREATE TABLE yaosight.monitor_periods (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    monitor_id uuid NOT NULL,
    slot timestamptz NOT NULL,
    job_id uuid,
    status text NOT NULL CHECK (status IN ('queued','blocked')),
    PRIMARY KEY (workspace_id, project_id, monitor_id, slot),
    FOREIGN KEY (workspace_id, project_id, monitor_id) REFERENCES yaosight.monitors ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, project_id, job_id) REFERENCES yaosight.jobs (workspace_id,project_id,id)
);
