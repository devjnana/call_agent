export function buildHealthController(registry) {
  return {
    live(req, res) {
      res.json({
        ok: true,
        active_sessions: registry.size(),
        uptime_s: Math.floor(process.uptime()),
        ts: new Date().toISOString(),
      });
    },
    ready(req, res) {
      res.json({ ready: true });
    },
  };
}
