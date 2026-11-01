import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const storageSettingsSchema = z
  .object({
    runCacheAfterDays: z.number().int().min(1).max(3650).nullable().default(null),
  })
  .strict();
export type StorageSettings = z.infer<typeof storageSettingsSchema>;
export type AppSettings = StorageSettings & { revision: string };

export class SettingsStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  get(): AppSettings {
    if (!existsSync(this.path)) return { ...storageSettingsSchema.parse({}), revision: 'initial' };
    return storageSettingsSchema.extend({ revision: z.string() }).parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }
  save(input: unknown): AppSettings {
    const { expectedRevision, settings } = z
      .object({
        expectedRevision: z.string(),
        settings: storageSettingsSchema,
      })
      .strict()
      .parse(input);
    if (expectedRevision !== this.get().revision)
      throw Object.assign(new Error('Settings changed. Reload them before saving.'), { code: 'REVISION_CONFLICT' });
    const next = { ...settings, revision: randomUUID() };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    return next;
  }
}
const root = new URL('..', import.meta.url).pathname;
export const appSettings = new SettingsStore(process.env.E2E_SETTINGS_PATH ?? join(root, '.state/settings.json'));
