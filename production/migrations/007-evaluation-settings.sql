ALTER TABLE yaosight.projects ADD COLUMN evaluation_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
