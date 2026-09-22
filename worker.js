import { onRequest as health } from './functions/api/health.js';
import { onRequest as search } from './functions/api/search.js';
import { onRequest as isochrone } from './functions/api/isochrone.js';

const API_HANDLERS = new Map([
  ['/api/health', health],
  ['/api/search', search],
  ['/api/isochrone', isochrone],
]);

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const handler = API_HANDLERS.get(url.pathname);
    if (!handler) return new Response('Not found', { status: 404 });
    return handler({ request, env });
  },
};
