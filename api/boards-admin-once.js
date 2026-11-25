// TEMPORARY one-off admin: purge one player name from every board.
// Delete this file immediately after use.
const { redisCmd, redisConfig } = require('./_redis');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!redisConfig()) { res.status(503).json({ ok: false }); return; }
  const name = typeof req.query?.name === 'string' ? req.query.name : '';
  if (req.query?.action !== 'purge' || !name) {
    res.status(400).json({ ok: false, error: 'bad_request' });
    return;
  }
  try {
    const keys = ['zc:ranking', 'zc:weekly:2026-11-24', 'zc:daily:2026-11-26',
      'zc:daily:2026-11-26:ticket:単勝', 'zc:daily:2026-11-26:ticket:馬連',
      'zc:daily:2026-11-26:ticket:三連複', 'zc:daily:2026-11-26:ticket:三連単'];
    for (const k of keys) {
      await redisCmd(['ZREM', k, name]);
      await redisCmd(['HDEL', k + ':detail', name]);
    }
    await redisCmd(['HDEL', 'zc:details', name]);
    await redisCmd(['HDEL', 'zc:top3', name]);
    await redisCmd(['HDEL', 'zc:daily:2026-11-26:runs', name]);
    const total = await redisCmd(['ZCARD', 'zc:ranking']);
    res.status(200).json({ ok: true, purged: name, total });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
