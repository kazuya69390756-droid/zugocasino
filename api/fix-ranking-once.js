// One-shot cleanup (2026-11-25): remove zugo's legacy WIN5 record
// (oddsText 6,425,252,525, made with the removed "25252525" reel item).
// Hardcoded to that single record only. Delete this file right after use.
const { redisCmd, redisConfig } = require('./_redis');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!redisConfig()) {
    res.status(503).json({ ok: false, error: 'ranking_not_ready' });
    return;
  }
  try {
    const name = 'ずご';
    const raw = await redisCmd(['HGET', 'zc:top3', name]);
    let top3 = [];
    if (raw) { try { top3 = JSON.parse(raw); } catch (e) { top3 = []; } }
    if (!Array.isArray(top3)) top3 = [];
    const before = top3.length;
    top3 = top3.filter((r) => r.oddsText !== '6,425,252,525');
    top3.sort((a, b) => b.score - a.score);
    top3 = top3.slice(0, 3);
    await redisCmd(['HSET', 'zc:top3', name, JSON.stringify(top3)]);
    if (top3.length) {
      await redisCmd(['ZADD', 'zc:ranking', top3[0].score, name]);
      await redisCmd(['HSET', 'zc:details', name, JSON.stringify(top3[0])]);
    } else {
      await redisCmd(['ZREM', 'zc:ranking', name]);
      await redisCmd(['HDEL', 'zc:details', name]);
    }
    res.status(200).json({ ok: true, removed: before - top3.length, top3 });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
