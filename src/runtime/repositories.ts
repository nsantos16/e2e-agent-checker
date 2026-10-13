import { Context, Layer } from 'effect';
import { caseCatalog } from '../cases.ts';
import { listEnvironments, getEnvironment, saveEnvironment, deleteEnvironment } from '../environments.ts';
import { attempt } from './effect.ts';

// Existing synchronous transactions keep revision checks and atomic file replacement together.
const cases = {
  list: (...args: Parameters<typeof caseCatalog.list>) => attempt(() => caseCatalog.list(...args)),
  get: (...args: Parameters<typeof caseCatalog.get>) => attempt(() => caseCatalog.get(...args)),
  create: (...args: Parameters<typeof caseCatalog.create>) => attempt(() => caseCatalog.create(...args)),
  update: (...args: Parameters<typeof caseCatalog.update>) => attempt(() => caseCatalog.update(...args)),
  archive: (...args: Parameters<typeof caseCatalog.archive>) => attempt(() => caseCatalog.archive(...args)),
  syncQase: (...args: Parameters<typeof caseCatalog.syncQase>) => attempt(() => caseCatalog.syncQase(...args)),
};
const environments = {
  list: () => attempt(listEnvironments),
  get: (id?: string) => attempt(() => getEnvironment(id)),
  save: (input: unknown) => attempt(() => saveEnvironment(input)),
  delete: (id: string, revision: string) => attempt(() => deleteEnvironment(id, revision)),
};
export class CaseRepository extends Context.Service<CaseRepository, typeof cases>()('checker/CaseRepository') {}
export class EnvironmentRepository extends Context.Service<EnvironmentRepository, typeof environments>()('checker/EnvironmentRepository') {}
export const RepositoriesLive = Layer.mergeAll(Layer.succeed(CaseRepository, cases), Layer.succeed(EnvironmentRepository, environments));
