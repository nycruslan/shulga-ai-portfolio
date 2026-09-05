import { defineMiddleware } from 'astro:middleware';
import { auth, isAllowed } from './lib/auth';
import { json } from './lib/http';

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;

  // Only /admin needs a session. Skipping everything else keeps the Turso
  // lookup off the public site (no headers access during prerender, no DB
  // round-trip on /api/chat) since those routes never read locals.user.
  if (!path.startsWith('/admin')) return next();

  if (auth) {
    const session = await auth.api.getSession({ headers: context.request.headers });
    if (session) context.locals.user = session.user;
  }

  // Login and Better Auth's own endpoints must stay public or sign-in loops.
  const isAuthRoute = path === '/admin/login' || path.startsWith('/admin/api/auth');
  if (!isAuthRoute) {
    const email = context.locals.user?.email;
    // isAllowed() always includes the owner, so an empty list still lets the
    // owner in and no one else.
    if (!auth || !isAllowed(email)) {
      return path.startsWith('/admin/api/')
        ? json({ error: 'Unauthorized.' }, 401)
        : context.redirect('/admin/login');
    }
  }

  return next();
});
