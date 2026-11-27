CREATE TABLE yaosight.accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer, subject)
);

CREATE TABLE yaosight.sessions (
    token_hash text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES yaosight.accounts ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiration ON yaosight.sessions (expires_at);

CREATE TABLE yaosight.login_flows (
    state_hash text PRIMARY KEY,
    verifier text NOT NULL,
    nonce text NOT NULL,
    invitation_hash text,
    expires_at timestamptz NOT NULL
);

CREATE TABLE yaosight.workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE yaosight.members (
    workspace_id uuid NOT NULL REFERENCES yaosight.workspaces ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES yaosight.accounts ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    PRIMARY KEY (workspace_id, account_id)
);
CREATE INDEX members_by_account ON yaosight.members (account_id, workspace_id);

CREATE TABLE yaosight.invitations (
    token_hash text PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES yaosight.workspaces ON DELETE CASCADE,
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_by uuid REFERENCES yaosight.accounts,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);

CREATE TABLE yaosight.projects (
    workspace_id uuid NOT NULL REFERENCES yaosight.workspaces ON DELETE CASCADE,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id)
);

CREATE TABLE yaosight.audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES yaosight.workspaces,
    actor_id uuid REFERENCES yaosight.accounts,
    action text NOT NULL,
    target text,
    result text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_by_workspace ON yaosight.audit_events (workspace_id, id DESC);

CREATE TABLE yaosight.artifacts (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    object_key text NOT NULL UNIQUE,
    name text NOT NULL,
    media_type text NOT NULL,
    byte_length bigint NOT NULL CHECK (byte_length >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, project_id, id),
    FOREIGN KEY (workspace_id, project_id) REFERENCES yaosight.projects ON DELETE CASCADE
);
