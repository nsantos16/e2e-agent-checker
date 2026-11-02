-- Run ownership is an application identity, never a provider account or test login.
CREATE TABLE checker.runs (
  org_id uuid NOT NULL REFERENCES checker.organizations(id),
  id uuid NOT NULL,
  initiated_by uuid NOT NULL,
  data jsonb NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, initiated_by) REFERENCES checker.memberships(org_id, user_id)
);
CREATE INDEX runs_org_recent ON checker.runs(org_id, created_at DESC, id DESC);
CREATE INDEX runs_org_user_recent ON checker.runs(org_id, initiated_by, created_at DESC, id DESC);
