import { defineEventHandler, sendWebResponse, toWebRequest } from 'h3';
import { actorFromCookie, selectionHandler } from '../../utils/selection';

export default defineEventHandler(async (event) => {
  const actor = actorFromCookie(event.node.req.headers.cookie ?? null);
  const response = await selectionHandler(toWebRequest(event), { actor });
  return sendWebResponse(event, response);
});
