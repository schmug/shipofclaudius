// Worker entry. Static files live in public/ and are served by the ASSETS binding.
// Keep it stateless: no D1/KV/Durable Object/Queue bindings, and never fetch a URL taken
// from the request — a candidate on a shared preview domain must not become an open proxy.
export function healthBody(now) {
  return { ok: true, service: '{{SLUG}}', time: now };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json(healthBody(new Date().toISOString()), { headers: { 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(request);
  },
};
