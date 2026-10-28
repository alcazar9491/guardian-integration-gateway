import type { Response } from 'express';

/**
 * A signal that aborts when the client goes away before the response is finished. It listens on the
 * response: `req.on('close')` fires as soon as the request body has been read, which is not a disconnect.
 */
export function clientDisconnectSignal(res: Response): AbortSignal {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}
