import { createServer } from 'node:http';

// Disposable HTTP fixtures; no application server, credentials, or external requests.
export async function readinessServer() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture');
    requests.push(url.pathname);
    response.setHeader('cache-control', 'no-store');
    if (url.searchParams.has('redirectTo')) {
      response.writeHead(302, { location: url.searchParams.get('redirectTo')! });
      response.end();
      return;
    }
    if (url.pathname === '/background') {
      // More frequent than networkidle's quiet period, with overlapping responses.
      const timer = setTimeout(() => response.end('{}'), 200);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname === '/http-error') {
      response.writeHead(503, { 'content-type': 'text/html' });
      response.end('<h1>Service unavailable</h1>');
      return;
    }
    if (url.pathname === '/transport-error') {
      request.socket.destroy();
      return;
    }
    response.setHeader('content-type', 'text/html');
    const scenario = url.searchParams.get('scenario') ?? 'ready';
    const content = '<main data-state="ready"><h1>Destination</h1><button>Continue</button></main>';
    const spinner = '<span role="img" aria-label="loading">Loading</span>';
    let script = '';
    let body = '';
    if (url.pathname === '/home' || url.pathname === '/client-list') {
      body = '<main data-state="ready"><h1>Home</h1><div data-testid="client-list-loaded">Clients loaded</div></main>';
      script = 'sessionStorage.setItem("warm", "yes");';
    } else if (url.pathname === '/cold' && scenario === 'redirect' && !request.headers.cookie?.includes('warm=yes')) {
      // The home page warms client-side state; a real navigation still demonstrates the wrong destination.
      script = 'location.replace("/home?scenario=redirect")';
    } else if (url.pathname === '/cold' || url.pathname === '/broken-cold') {
      script = `if (sessionStorage.getItem('warm') && location.pathname !== '/broken-cold') {
        document.body.innerHTML = ${JSON.stringify(content)};
      } else { document.body.innerHTML = ${JSON.stringify(spinner)}; }`;
    } else if (url.pathname === '/login') {
      body = '<h1>Sign in</h1>' + spinner;
    } else if (scenario === 'delayed') {
      // An early control is NOT sufficient. Loading and loaded state mount later, without network activity.
      body = '<main data-state="booting"><h1>Destination</h1><button>Continue</button></main>';
      script = `setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(spinner)}), 900);
        setTimeout(() => { document.querySelector('main').dataset.state = 'ready'; }, 1400);
        setTimeout(() => { document.querySelector('[aria-label="loading"]').remove(); }, 1800);`;
    } else if (scenario === 'never') {
      body = '<main><h1>Shell only</h1></main>'; // No spinner, but no ready state either.
    } else if (scenario === 'multiple') {
      body = content + '<span role="img" aria-label="loading" hidden></span>' + spinner;
      script = 'setTimeout(() => document.querySelectorAll("[aria-label=loading]")[1].remove(), 450);';
    } else {
      body = content;
    }
    if (url.pathname === '/home') script += 'document.cookie="warm=yes; path=/";';
    if (scenario === 'background') script += 'fetch("/background"); setInterval(() => fetch("/background"), 100);';
    response.end(
      `<!doctype html><html><head><title>Readiness fixture: ${scenario}</title></head><body>${body}<script>${script}</script></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
