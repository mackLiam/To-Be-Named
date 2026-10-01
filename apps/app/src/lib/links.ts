import { SUPPORT_EMAIL } from '@forms/shared/brand';

/** Public site pages the app links to (apps/web routes). The domain stays
 * zells.com on purpose (FORMS is a working name; see the rebrand note). */
const SITE = 'https://zells.com';

export const PRIVACY_URL = `${SITE}/privacy`;
export const TERMS_URL = `${SITE}/terms`;
export const SUPPORT_URL = `${SITE}/support`;
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;
export { SUPPORT_EMAIL };
