import type { ErrorRequestHandler } from 'express';

// express.json()'s failures as the API's JSON errors: 413 too_large, 400
// bad_request; anything else goes on to the app's 500 handler.
export const bodyErrors: ErrorRequestHandler = (err, _req, res, next) => {
  const status = (err as { status?: number }).status;
  if (status === 413) return void res.status(413).json({ error: 'too_large' });
  if (status === 400) return void res.status(400).json({ error: 'bad_request' });
  next(err);
};
