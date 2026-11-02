import { defineEventHandler } from 'nuxt/server';
import { actorFromCookie, selectionHandler } from '../../utils/selection';

export default defineEventHandler((event) => {
  const actor = actorFromCookie(event.req.headers.get('cookie'));
  return selectionHandler(event.req, { actor });
});
