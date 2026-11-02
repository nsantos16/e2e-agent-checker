import { createFileRoute } from '@tanstack/react-router';

// The shared shell renders the runs dashboard at home, inside the original UI.
export const Route = createFileRoute('/')({ component: () => null });
