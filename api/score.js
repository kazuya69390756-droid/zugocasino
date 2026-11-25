// POST /api/score {name, score, ticket, oddsText}
// Score = the odds of a HIT result (misses are never submitted).
// Storage (all keys prefixed "zc:" so they never mix with ずごたたき "zt:"):
//  - zc:top3 (hash name -> JSON runs): the player's lifetime best-10 runs
//    (key name kept from the top-3 era for data continuity)
//  - zc:ranking (zset) + zc:details: lifetime overall, best run per player
//  - zc:daily:<JST date> (+ :detail): today's best per player, TTL 8 days
//  - zc:daily:<JST date>:runs (hash name -> JSON runs): the player's own
//    top-5 runs of the day, TTL 8 days
//  - zc:weekly:<JST Monday> (+ :detail): this week's best per player,
//    TTL 14 days; the week rolls over Sunday 24:00 (= Monday 00:00 JST)
//  - zc:daily:<date>:ticket:<ticket> (+ :detail): today's best per
//    player for that ticket type (resets daily, TTL 8 days)
const { redisCmd, redisConfig } = require('./_redis');

const RANK_KEY = 'zc:ranking';
const DETAIL_KEY = 'zc:details';
const TOP3_KEY = 'zc:top3';
const MAX_SCORE = 2000000000;
const DAY_TTL = 691200;
const WEEK_TTL = 1209600;
const BOARD_CAP = 250; // keep at most the top 250 players per board

function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}
function cleanScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // odds carry at most 1 decimal place
  return Math.min(MAX_SCORE, Math.round(n * 10) / 10);
}

function pad(n) { return String(n).padStart(2, '0'); }
function jstDate(ts) { return new Date(ts + 9 * 3600 * 1000); }
function dailyKey(ts) {
  const d = jstDate(ts);
  return 'zc:daily:' + d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function weeklyKey(ts) {
  const d = jstDate(ts);
  const shift = (d.getUTCDay() + 6) % 7; // days since Monday
  const mon = new Date(d.getTime() - shift * 86400 * 1000);
  return 'zc:weekly:' + mon.getUTCFullYear() + '-' + pad(mon.getUTCMonth() + 1) + '-' + pad(mon.getUTCDate());
}

// Trim a board to the top BOARD_CAP players, dropping the lowest
// scores and their detail entries.
async function trimBoard(zKey, detKey) {
  const total = Number(await redisCmd(['ZCARD', zKey]));
  if (!Number.isFinite(total) || total <= BOARD_CAP) return;
  const excess = total - BOARD_CAP;
  const dropped = await redisCmd(['ZRANGE', zKey, 0, excess - 1]); // lowest first
  await redisCmd(['ZREMRANGEBYRANK', zKey, 0, excess - 1]);
  for (const nm of dropped || []) {
    await redisCmd(['HDEL', detKey, nm]);
  }
}

// Keep only the player's best run on a board (zset + detail hash).
async function upsertBoard(zKey, detKey, name, run, ttl) {
  const prev = await redisCmd(['ZSCORE', zKey, name]);
  const prevScore = prev === null ? -1 : Number(prev);
  if (run.score > prevScore) {
    await redisCmd(['ZADD', zKey, run.score, name]);
    await redisCmd(['HSET', detKey, name, JSON.stringify(run)]);
    await trimBoard(zKey, detKey);
  }
  if (ttl) {
    await redisCmd(['EXPIRE', zKey, ttl]);
    await redisCmd(['EXPIRE', detKey, ttl]);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!redisConfig()) {
    res.status(503).json({ ok: false, error: 'ranking_not_ready' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};
  const name = cleanName(body.name);
  const score = cleanScore(body.score);
  const ticket = cleanName(body.ticket);
  const oddsText = cleanName(body.oddsText);
  if (!name || score === null) {
    res.status(400).json({ ok: false, error: 'bad_request' });
    return;
  }
  try {
    const now = Date.now();
    const run = { score, ticket, oddsText, ts: now };
    // personal lifetime best-10
    let topList = [];
    const rawTop = await redisCmd(['HGET', TOP3_KEY, name]);
    if (rawTop) { try { topList = JSON.parse(rawTop); } catch (e) { topList = []; } }
    if (!Array.isArray(topList)) topList = [];
    topList.push(run);
    topList.sort((a, b) => b.score - a.score);
    topList = topList.slice(0, 10);
    await redisCmd(['HSET', TOP3_KEY, name, JSON.stringify(topList)]);
    // lifetime overall ranking = best hit odds
    const best = topList[0].score;
    const prev = await redisCmd(['ZSCORE', RANK_KEY, name]);
    const prevScore = prev === null ? -1 : Number(prev);
    const updated = best > prevScore;
    if (updated) {
      await redisCmd(['ZADD', RANK_KEY, best, name]);
      await redisCmd(['HSET', DETAIL_KEY, name, JSON.stringify(topList[0])]);
      await trimBoard(RANK_KEY, DETAIL_KEY);
    }
    // daily / weekly / per-ticket boards
    const dk = dailyKey(now);
    await upsertBoard(dk, dk + ':detail', name, run, DAY_TTL);
    // the player's own runs today (top 5), for "your today TOP5"
    const runsKey = dk + ':runs';
    let dayRuns = [];
    const rawRuns = await redisCmd(['HGET', runsKey, name]);
    if (rawRuns) { try { dayRuns = JSON.parse(rawRuns); } catch (e) { dayRuns = []; } }
    if (!Array.isArray(dayRuns)) dayRuns = [];
    dayRuns.push(run);
    dayRuns.sort((a, b) => b.score - a.score);
    dayRuns = dayRuns.slice(0, 5);
    await redisCmd(['HSET', runsKey, name, JSON.stringify(dayRuns)]);
    await redisCmd(['EXPIRE', runsKey, DAY_TTL]);
    const wk = weeklyKey(now);
    await upsertBoard(wk, wk + ':detail', name, run, WEEK_TTL);
    if (ticket) {
      const tk = dk + ':ticket:' + ticket; // per-ticket boards reset daily
      await upsertBoard(tk, tk + ':detail', name, run, DAY_TTL);
    }
    const rankIdx = await redisCmd(['ZREVRANK', RANK_KEY, name]);
    const total = await redisCmd(['ZCARD', RANK_KEY]);
    res.status(200).json({
      ok: true,
      updated,
      best,
      rank: rankIdx === null ? null : rankIdx + 1,
      total,
      myTop3: topList.slice(0, 3),
      myTop10: topList,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
