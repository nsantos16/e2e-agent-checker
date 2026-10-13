import { RepositoriesLive } from './repositories.ts';
import { Layer } from 'effect';
import { ProcessRunnerLive } from '../process.ts';
import { CredentialStoreLive } from '../credentials.ts';
import { ProviderRegistryLive } from '../providers/index.ts';
import { QaseSourceLive } from '../qase.ts';
import { PricingCatalogLive } from '../pricing.ts';

// External capabilities are wired once at public entry points and can be replaced in tests.
export const CheckerLive = Layer.mergeAll(
  ProcessRunnerLive,
  CredentialStoreLive,
  ProviderRegistryLive,
  PricingCatalogLive,
  QaseSourceLive,
  RepositoriesLive,
);
