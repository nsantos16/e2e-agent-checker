import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export async function migrate(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(148329801)');
    await client.query('CREATE SCHEMA IF NOT EXISTS checker');
    await client.query(
      'CREATE TABLE IF NOT EXISTS checker.migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of ['001.sql', '002.sql']) {
      const sql = await readFile(
        new URL(`./migrations/${name}`, import.meta.url),
        'utf8',
      );
      const digest = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query(
        'SELECT sha256 FROM checker.migrations WHERE name = $1',
        [name],
      );
      if (previous.rows.length) {
        if (previous.rows[0].sha256 !== digest)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query(
        'INSERT INTO checker.migrations(name, sha256) VALUES ($1, $2)',
        [name, digest],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
