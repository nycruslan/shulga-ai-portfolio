import { defineMiddleware } from 'astro:middleware';
import { auth, OWNER } from './lib/auth';

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  const guarded = path.startsWith('/admin') && path !== '/admin/login';

  if (auth) {
    const session = await auth.api.getSession({ headers: context.request.headers });
    if (session) {
      context.locals.user = session.user;
      context.locals.session = session.session;
    }
  }

  if (guarded) {
    const email = context.locals.user?.email;
    if (!auth || !email || (OWNER && email !== OWNER)) {
      return context.redirect('/admin/login');
    }
  }

  return next();
});
