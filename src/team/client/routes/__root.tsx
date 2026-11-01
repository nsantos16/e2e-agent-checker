import { createRootRoute, Link, Outlet } from '@tanstack/react-router';
import { useWorkspace } from '../context.tsx';
export const Route = createRootRoute({
  component: Layout,
  notFoundComponent: () => (
    <main>
      <h1>Page not found</h1>
      <Link to="/cases" search={{ search: '' }}>
        Open cases
      </Link>
    </main>
  ),
  errorComponent: ({ error, reset }) => (
    <main role="alert">
      <h1>Could not open this page</h1>
      <p>{error instanceof Error ? error.message : 'Please try again.'}</p>
      <button onClick={reset}>Try again</button>
    </main>
  ),
});
function Layout() {
  const { actor } = useWorkspace();
  return (
    <div className="workspace">
      <aside>
        <Link className="brand" to="/cases" search={{ search: '' }}>
          Checker<span>Team workspace</span>
        </Link>
        <nav>
          <Link
            to="/cases"
            search={{ search: '' }}
            activeProps={{ className: 'active' }}
          >
            Cases
          </Link>
          <Link to="/account" activeProps={{ className: 'active' }}>
            Account
          </Link>
        </nav>
        <div className="identity">
          <strong>{actor.organizationName}</strong>
          <span>
            {actor.name} · {actor.role}
          </span>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
