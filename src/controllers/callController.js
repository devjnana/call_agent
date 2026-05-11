export function buildCallController(orchestrator) {
  return {
    async start(req, res) {
      try {
        const out = await orchestrator.initiateFromCrm(req.body);
        res.status(202).json(out);
      } catch (err) {
        res.status(400).json({ error: err.message || 'bad_request' });
      }
    },
  };
}
