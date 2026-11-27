CREATE TABLE yaosight.vision_checks (
    platform_id text NOT NULL,
    model text NOT NULL,
    route_fingerprint text NOT NULL,
    verified_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (platform_id, model, route_fingerprint)
);
