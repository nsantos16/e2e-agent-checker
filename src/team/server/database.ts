import { Pool } from 'pg';
import { Kysely, PostgresDialect, type Generated } from 'kysely';
import type { Actor, CaseDraft, Role, TeamCase, RunData } from '../contracts.ts';

export interface Database {
  organizations: { id: string; clerk_org_id: string; name: string };
  users: {
    id: string;
    clerk_user_id: string;
    name: string;
    disabled: Generated<boolean>;
  };
  memberships: {
    org_id: string;
    user_id: string;
    role: Role;
    disabled: Generated<boolean>;
  };
  auth_sessions: {
    session_id: string;
    user_id: string;
    last_seen_at: Date;
    revoked: Generated<boolean>;
  };
  cases: {
    id: string;
    org_id: string;
    data: CaseDraft;
    revision: number;
    created_by: string | null;
    updated_by: string | null;
    created_at: Date;
    updated_at: Date;
  };
  case_versions: {
    org_id: string;
    case_id: string;
    revision: number;
    body: TeamCase;
  };
  runs: {
    id: string;
    org_id: string;
    initiated_by: string;
    data: RunData;
    revision: number;
    created_at: Date;
    updated_at: Date;
  };
  audit_events: {
    id: string;
    org_id: string;
    actor_id: string | null;
    action: string;
    resource_id: string;
    created_at: Date;
  };
  idempotency_receipts: {
    org_id: string;
    actor_id: string;
    key: string;
    request_hash: string;
    response: TeamCase;
  };
  webhook_receipts: { id: string; type: string; received_at: Date };
}
export type AuthenticatedActor = Actor & {
  sessionId: string;
  clerkUserId: string;
};
export function openDatabase(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  // Idle connection failures must not crash the API during a database restart.
  // Requests and readiness checks still fail; pg replaces the failed connection.
  pool.on('error', (error) =>
    console.error('Team database connection unavailable', {
      code: (error as { code?: string }).code,
    }),
  );
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  }).withSchema('checker');
  return { db, pool };
}
export type TeamDatabase = ReturnType<typeof openDatabase>['db'];
