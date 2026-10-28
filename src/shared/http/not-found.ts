import type { RequestHandler } from 'express';

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({
    requestId: res.locals.requestId,
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  });
};
