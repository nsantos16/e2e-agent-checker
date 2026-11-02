import { createRootRoute, Link } from '@tanstack/react-router';
import { z } from 'zod';
import { TeamShell } from '../shell.tsx';

export const Route = createRootRoute({
  validateSearch: z.object({
    search: z.string().max(200).catch(''),
    after: z.uuid().optional().catch(undefined),
    userId: z.uuid().optional().catch(undefined),
    runAfter: z.string().max(300).optional().catch(undefined),
    caseId: z
      .union([z.uuid(), z.literal('new')])
      .optional()
      .catch(undefined),
  }),
  component: TeamShell,
  notFoundComponent: () => (
    <div className="team-route-message" role="alert">
      Page not found.{' '}
      <Link to="/" search={{ search: '' }}>
        Return to your workspace
      </Link>
    </div>
  ),
  errorComponent: ({ reset }) => (
    <div className="team-route-message" role="alert">
      Could not open this view. <button onClick={reset}>Try again</button>
    </div>
  ),
});
