// GET /api/ranking?name=<optional>
// -> {ok, total, entries (lifetime overall TOP10, kept for the owner),
//     daily (today's overall TOP10), weekly (this week's overall TOP10),
//     tickets {単勝/馬連/三連複/三連単: TOP5},
//     me:{rank,best,myTop3,myTop10} | null}
// Scores are hit odds; display text (ticket / oddsText) comes from stored runs.
const { redisCmd, redisConfig, presentEnvNames } = require('./_redis');

const RANK_KEY = 'zc:ranking';
const DETAIL_KEY = 'zc:details';
const TOP3_KEY = 'zc:top3';
const TICKET_BOARDS = ['単勝', '馬連', '三連複', '三連単'];

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

async function readBoard(zKey, detKey, n) {
  const flat = await redisCmd(['ZREVRANGE', zKey, 0, n - 1, 'WITHSCORES']);
  const entries = [];
  for (let i = 0; i < flat.length; i += 2) {
    const name = flat[i];
    const score = Number(flat[i + 1]);
    let detail = {};
    const raw = await redisCmd(['HGET', detKey, name]);
    if (raw) { try { detail = JSON.parse(raw); } catch (e) { detail = {}; } }
    entries.push({
      rank: entries.length + 1,
      name,
      score,
      ticket: detail.ticket || '',
      oddsText: detail.oddsText || '',
      ts: detail.ts || null,
    });
  }
  return entries;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Allow other pages the owner runs (e.g. the start page) to read rankings.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!redisConfig()) {
    res.status(503).json({ ok: false, error: 'ranking_not_ready', envNames: presentEnvNames() });
    return;
  }
  try {
    const now = Date.now();
    const total = await redisCmd(['ZCARD', RANK_KEY]);
    const entries = await readBoard(RANK_KEY, DETAIL_KEY, 10);
    // ?date=YYYY-MM-DD (JST) reads that day's daily board instead of today's
    // (used for the morning post that reports yesterday's final ranking).
    const dateParam = typeof req.query?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date : null;
    const dk = dateParam ? 'zc:daily:' + dateParam : dailyKey(now);
    const daily = await readBoard(dk, dk + ':detail', 10);
    const wk = weeklyKey(now);
    const weekly = await readBoard(wk, wk + ':detail', 10);
    const tickets = {};
    for (const t of TICKET_BOARDS) {
      const tk = dk + ':ticket:' + t; // per-ticket boards are daily
      tickets[t] = await readBoard(tk, tk + ':detail', 5);
    }
    let me = null;
    const myName = typeof req.query?.name === 'string' ? req.query.name.trim().slice(0, 24) : '';
    if (myName) {
      let myTop = [];
      const rawTop = await redisCmd(['HGET', TOP3_KEY, myName]);
      if (rawTop) { try { myTop = JSON.parse(rawTop); } catch (e) { myTop = []; } }
      if (!Array.isArray(myTop)) myTop = [];
      const myBest = await redisCmd(['ZSCORE', RANK_KEY, myName]);
      // The player's own top-5 runs today. Fallback: today's board
      // detail (their best run today) for runs recorded before the
      // per-day runs list existed.
      let myDailyTop5 = [];
      const todayDk = dailyKey(now);
      const rawDay = await redisCmd(['HGET', todayDk + ':runs', myName]);
      if (rawDay) { try { myDailyTop5 = JSON.parse(rawDay); } catch (e) { myDailyTop5 = []; } }
      if (!Array.isArray(myDailyTop5)) myDailyTop5 = [];
      if (!myDailyTop5.length) {
        const rawDet = await redisCmd(['HGET', todayDk + ':detail', myName]);
        if (rawDet) { try { myDailyTop5 = [JSON.parse(rawDet)]; } catch (e) { myDailyTop5 = []; } }
      }
      if (myBest !== null) {
        const rankIdx = await redisCmd(['ZREVRANK', RANK_KEY, myName]);
        me = {
          name: myName,
          best: Number(myBest),
          rank: rankIdx === null ? null : rankIdx + 1,
          myTop3: myTop.slice(0, 3),
          myTop10: myTop,
          myDailyTop5,
        };
      } else if (myTop.length) {
        // Outside the lifetime top-250 cap: personal records still exist.
        me = {
          name: myName,
          best: myTop[0].score,
          rank: null,
          myTop3: myTop.slice(0, 3),
          myTop10: myTop,
          myDailyTop5,
        };
      } else if (myDailyTop5.length) {
        me = {
          name: myName,
          best: myDailyTop5[0].score,
          rank: null,
          myTop3: [],
          myTop10: [],
          myDailyTop5,
        };
      }
    }
    res.status(200).json({ ok: true, total, entries, daily, weekly, tickets, me });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
