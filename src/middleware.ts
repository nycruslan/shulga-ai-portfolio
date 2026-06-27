import { defineMiddleware } from 'astro:middleware';
import { auth, OWNER } from './lib/auth';

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
      context.locals.session = session.session;
    }
  }

  if (path !== '/admin/login') {
    const email = context.locals.user?.email?.trim().toLowerCase();
    // Fail closed: require auth wired, an owner configured, and an exact match.
    if (!auth || !OWNER || !email || email !== OWNER) {
      return context.redirect('/admin/login');
    }
  }

  return next();
});
