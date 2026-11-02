import { createFileRoute } from '@tanstack/react-router';

// The existing thread/composer is the home view, with no admin-page redirect.
export const Route = createFileRoute('/')({ component: () => null });
