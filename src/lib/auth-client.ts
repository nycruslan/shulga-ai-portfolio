import { createAuthClient } from 'better-auth/client';
import { passkeyClient } from '@better-auth/passkey/client';

// baseURL defaults to the current origin in the browser, which is what we want.
export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});
