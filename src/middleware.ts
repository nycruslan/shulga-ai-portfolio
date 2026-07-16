import { defineMiddleware } from 'astro:middleware';
import { auth, isAllowed } from './lib/auth';

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;

  // Only /admin needs a session. Skipping everything else keeps the Turso
  // lookup off the public site (no headers access during prerender, no DB
  // round-trip on /api/chat) since those routes never read locals.user.
  if (!path.startsWith('/admin')) return next();

  if (auth) {
    const session = await auth.api.getSession({ headers: context.request.headers });
    if (session) {
      context.locals.user = session.user;
    }
  }

  if (path !== '/admin/login') {
    const email = context.locals.user?.email;
    // Fail closed: require auth wired and the session email on the allowlist.
    // isAllowed() always includes the owner, so an empty list still lets the
    // owner in and no one else.
    if (!auth || !isAllowed(email)) {
      return context.redirect('/admin/login');
    }
  }

  return next();
});
