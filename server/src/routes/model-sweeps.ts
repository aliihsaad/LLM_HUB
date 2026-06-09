import { Router } from 'express';
import type { Request, Response } from 'express';
import { getModelSweepJob, startModelSweep } from '../services/model-sweeps.js';

export const modelSweepsRouter = Router();

modelSweepsRouter.post('/', (_req: Request, res: Response) => {
  const job = startModelSweep();
  res.status(202).json(job);
});

modelSweepsRouter.get('/:id', (req: Request, res: Response) => {
  const job = getModelSweepJob(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: { message: 'Model sweep not found' } });
    return;
  }

  res.json(job);
});
