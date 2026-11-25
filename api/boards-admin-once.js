// One-shot admin for the 2026-11-25 ranking boards rollout. Delete after use.
// POST {action:'seed'}  -> backfill daily/weekly/ticket boards from zc:top3 runs
// POST {action:'purge', name} -> remove one player from every zc: board
const { redisCmd, redisConfig } = require('./_redis');

function pad(n) { return String(n).padStart(2, '0'); }
function jstDate(ts) { return new Date(ts + 9 * 3600 * 1000); }
function dailyKey(ts) {
  const d = jstDate(ts);
  return 'zc:daily:' + d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function weeklyKey(ts) {
  const d = jstDate(ts);
  const shift = (d.getUTCDay() + 6) % 7;
  const mon = new Date(d.getTime() - shift * 86400 * 1000);
  return 'zc:weekly:' + mon.getUTCFullYear() + '-' + pad(mon.getUTCMonth() + 1) + '-' + pad(mon.getUTCDate());
}
async function upsertBoard(zKey, detKey, name, run, ttl) {
  const prev = await redisCmd(['ZSCORE', zKey, name]);
  const prevScore = prev === null ? -1 : Number(prev);
  if (run.score > prevScore) {
    await redisCmd(['ZADD', zKey, run.score, name]);
    await redisCmd(['HSET', detKey, name, JSON.stringify(run)]);
  }
  if (ttl) {
    await redisCmd(['EXPIRE', zKey, ttl]);
    await redisCmd(['EXPIRE', detKey, ttl]);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!redisConfig()) { res.status(503).json({ ok: false }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  try {
    if (body.action === 'seed') {
      const flat = await redisCmd(['HGETALL', 'zc:top3']);
      let runs = 0;
      for (let i = 0; i < flat.length; i += 2) {
        const name = flat[i];
        let list = [];
        try { list = JSON.parse(flat[i + 1]); } catch (e) { list = []; }
        if (!Array.isArray(list)) continue;
        for (const run of list) {
          if (!run || !run.ts || !run.ticket) continue;
          runs++;
          const dk = dailyKey(run.ts);
          await upsertBoard(dk, dk + ':detail', name, run, 691200);
          const wk = weeklyKey(run.ts);
          await upsertBoard(wk, wk + ':detail', name, run, 1209600);
          await upsertBoard('zc:ticket:' + run.ticket, 'zc:ticket-detail:' + run.ticket, name, run, 0);
        }
      }
      res.status(200).json({ ok: true, seededRuns: runs });
      return;
    }
    if (body.action === 'purge' && typeof body.name === 'string' && body.name) {
      const name = body.name;
      const now = Date.now();
      const dk = dailyKey(now);
      const wk = weeklyKey(now);
      await redisCmd(['ZREM', 'zc:ranking', name]);
      await redisCmd(['HDEL', 'zc:details', name]);
      await redisCmd(['HDEL', 'zc:top3', name]);
      await redisCmd(['ZREM', dk, name]);
      await redisCmd(['HDEL', dk + ':detail', name]);
      await redisCmd(['ZREM', wk, name]);
      await redisCmd(['HDEL', wk + ':detail', name]);
      for (const t of ['単勝', '馬連', '三連複', '三連単', 'WIN5']) {
        await redisCmd(['ZREM', 'zc:ticket:' + t, name]);
        await redisCmd(['HDEL', 'zc:ticket-detail:' + t, name]);
      }
      res.status(200).json({ ok: true, purged: name });
      return;
    }
    res.status(400).json({ ok: false, error: 'bad_action' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
