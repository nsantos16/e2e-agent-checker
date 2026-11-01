CREATE SCHEMA IF NOT EXISTS checker;
CREATE TABLE checker.organizations (id uuid PRIMARY KEY, clerk_org_id text UNIQUE NOT NULL, name text NOT NULL);
CREATE TABLE checker.users (id uuid PRIMARY KEY, clerk_user_id text UNIQUE NOT NULL, name text NOT NULL, disabled boolean NOT NULL DEFAULT false);
CREATE TABLE checker.memberships (
  org_id uuid NOT NULL REFERENCES checker.organizations(id), user_id uuid NOT NULL REFERENCES checker.users(id),
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')), disabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, user_id)
);
-- Non-secret observations and local denials. Clerk remains the session issuer.
CREATE TABLE checker.auth_sessions (
  session_id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES checker.users(id),
  last_seen_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE checker.cases (
  org_id uuid NOT NULL REFERENCES checker.organizations(id), id uuid NOT NULL,
  data jsonb NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  created_by uuid, updated_by uuid, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES checker.memberships(org_id, user_id),
  FOREIGN KEY (org_id, updated_by) REFERENCES checker.memberships(org_id, user_id)
);
CREATE TABLE checker.case_versions (
  org_id uuid NOT NULL, case_id uuid NOT NULL, revision integer NOT NULL, body jsonb NOT NULL,
  PRIMARY KEY (org_id, case_id, revision), FOREIGN KEY (org_id, case_id) REFERENCES checker.cases(org_id, id)
);
CREATE TABLE checker.audit_events (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES checker.organizations(id), actor_id uuid,
  action text NOT NULL, resource_id text NOT NULL, created_at timestamptz NOT NULL,
  FOREIGN KEY (org_id, actor_id) REFERENCES checker.memberships(org_id, user_id)
);
CREATE INDEX audit_org_time ON checker.audit_events(org_id, created_at DESC);
CREATE TABLE checker.idempotency_receipts (
  org_id uuid NOT NULL, actor_id uuid NOT NULL, key uuid NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL,
  PRIMARY KEY (org_id, actor_id, key), FOREIGN KEY (org_id, actor_id) REFERENCES checker.memberships(org_id, user_id)
);
CREATE TABLE checker.webhook_receipts (id text PRIMARY KEY, type text NOT NULL, received_at timestamptz NOT NULL);
