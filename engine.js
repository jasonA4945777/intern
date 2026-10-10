/*
 * 護理之家排班引擎
 * ------------------------------------------------------------
 * 純運算，不碰畫面與資料庫，瀏覽器與 Node 都能直接載入。
 *
 *   buildContext(input)   把人員、班別、規則、預假整理成運算用的 ctx
 *   validate(ctx, cells)  檢核一份班表，回傳違規清單與統計（手動改班、自動排班共用同一套）
 *   solve(ctx, opts)      自動排班：多個亂數起點 + 模擬退火，取分數最低的一份
 *   labelOffs(ctx, cells) 把休假日標成 例 / 休 / 國 / OF
 *   capacity(ctx)         排班前的人力試算
 *
 * 規則全部是資料（DEFAULT_RULES），不寫死在流程裡；
 * 換樓層、換機構只需要改組別、班別與規則設定。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NHEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HARD = 1000;          // 一個硬性違規的分數
  const WD = ['日', '一', '二', '三', '四', '五', '六'];

  // ── 組別 ─────────────────────────────────────────────────
  const DEFAULT_GROUPS = [
    { id: 'nurse', name: '護理人員' },
    { id: 'care', name: '照顧服務員' },
  ];

  // ── 預設班別（依九德大愛 115 年 9 月班表）─────────────────
  // start / end：以「掛班日 0 點」為基準的小時。大夜掛在 X 日，實際是 X 日深夜到 X+1 日早上，
  // 所以寫成 24 → 32。輪班間隔就是用這兩個數字算出來的。
  const DEFAULT_SHIFTS = [
    { code: 'D', name: '白班', kind: 'work', group: 'nurse', start: 8, end: 16, color: '#15803d', bg: '#dcfce7', enabled: true },
    { code: 'E', name: '小夜', kind: 'work', group: 'nurse', start: 16, end: 24, color: '#b45309', bg: '#fef3c7', enabled: true },
    { code: 'N', name: '大夜', kind: 'work', group: 'nurse', start: 24, end: 32, color: '#6d28d9', bg: '#ede9fe', enabled: true },
    { code: 'D8', name: '日班', kind: 'work', group: 'care', start: 8, end: 20, color: '#0369a1', bg: '#e0f2fe', enabled: true },
    { code: 'N8', name: '夜班', kind: 'work', group: 'care', start: 20, end: 32, color: '#86198f', bg: '#fae8ff', enabled: true },
    { code: '例', name: '例假', kind: 'off', color: '#be123c', bg: '#fff1f2', enabled: true },
    { code: '休', name: '休息日', kind: 'off', color: '#be123c', bg: '#fff1f2', enabled: true },
    { code: '國', name: '國定假日', kind: 'off', color: '#be123c', bg: '#ffe4e6', enabled: true },
    { code: 'OF', name: '補休', kind: 'off', color: '#475569', bg: '#e5e7eb', enabled: true },
  ];
  // 休假標記用哪幾個代碼
  const OFF_LABELS = { holiday: '國', weekly: '例', rest: '休', extra: 'OF' };
  const OFF = 'OF';

  // ── 規則類型 ──────────────────────────────────────────────
  // fields 給介面自動產生設定表單用。
  const RULE_TYPES = {
    codeCount: { name: '每日班別人數', desc: '每天上指定班別的人數上下限（不計人力者不算）。', custom: true,
      fields: [{ k: 'codes', t: 'codes', label: '班別' }, { k: 'min', t: 'num', label: '最少', optional: true }, { k: 'max', t: 'num', label: '最多', optional: true }, { k: 'dayType', t: 'dayType', label: '適用日' }] },
    minRest: { name: '輪班間隔', desc: '前一班下班到下一班上班至少間隔幾小時。',
      fields: [{ k: 'hours', t: 'num', label: '小時' }] },
    maxConsec: { name: '連續上班上限', desc: '最多連續上班幾天（會接續上個月月底）。', custom: true,
      fields: [{ k: 'group', t: 'group', label: '適用組別' }, { k: 'days', t: 'num', label: '天數' }] },
    offQuota: { name: '每月休假天數', desc: '每人每月應休天數。「依行事曆」＝當月週六、週日加上平日國定假日的天數。',
      fields: [{ k: 'mode', t: 'select', label: '計算方式', options: [['calendar', '依行事曆'], ['fixed', '固定天數']] }, { k: 'fixed', t: 'num', label: '固定天數', optional: true }, { k: 'extraWeight', t: 'num', label: '多休一天的扣分' }] },
    leaveOff: { name: '預假必休', desc: '已登記的預假當天一定排休。', fields: [] },
    weekdayPin: { name: '固定星期班別', desc: '某人在指定的星期幾固定上某個班（例如兼職固定週一三五白班）。', custom: true,
      fields: [{ k: 'staff', t: 'staff', label: '人員' }, { k: 'weekdays', t: 'weekdays', label: '星期' }, { k: 'code', t: 'code', label: '班別' }, { k: 'skipHolidays', t: 'bool', label: '國定假日不適用' }] },
    staffCount: { name: '個人每月班數', desc: '某人當月上指定班別的次數上下限。', custom: true,
      fields: [{ k: 'staff', t: 'staff', label: '人員' }, { k: 'codes', t: 'codes', label: '班別' }, { k: 'min', t: 'num', label: '最少', optional: true }, { k: 'max', t: 'num', label: '最多', optional: true }] },
    maxConsecCode: { name: '同班別連續上限', desc: '指定班別最多連續上幾天（例如大夜不連上超過 5 天）。', custom: true,
      fields: [{ k: 'codes', t: 'codes', label: '班別' }, { k: 'days', t: 'num', label: '天數' }] },
    avoidCode: { name: '盡量少排的班別', desc: '每排一次就扣分，排不出來時才會用到。', softOnly: true, custom: true,
      fields: [{ k: 'codes', t: 'codes', label: '班別' }] },
    preferShift: { name: '依主要班別排', desc: '人員頁設了「主要班別」的人，排到其他班別時扣分。', softOnly: true, fields: [] },
    fairShift: { name: '班別次數平均', desc: '沒有設主要班別的人，同一班別的當月次數盡量接近。', softOnly: true,
      fields: [{ k: 'codes', t: 'codes', label: '班別' }] },
    fairWork: { name: '上班天數平均', desc: '同組的人當月上班天數盡量接近。', softOnly: true, fields: [] },
    fairWeekend: { name: '假日休假平均', desc: '同組的人，週末與國定假日的休假天數盡量平均。', softOnly: true, fields: [] },
    fewChanges: { name: '減少換班', desc: '中間沒有休假就換不同班別，每次扣分。', softOnly: true, fields: [] },
    isolatedWork: { name: '避免只上一天班', desc: '前後都是休假的單獨上班日，每次扣分。', softOnly: true, fields: [] },
  };

  // 人數與連班上限取自 115 年 9 月班表實際排法
  const DEFAULT_RULES = [
    { id: 'n-d', type: 'codeCount', name: '護理白班 D 每天 2 人', enabled: true, hard: true, weight: 50, params: { codes: ['D'], min: 2, max: 2, dayType: 'all' } },
    { id: 'n-e', type: 'codeCount', name: '護理小夜 E 每天 2 人', enabled: true, hard: true, weight: 50, params: { codes: ['E'], min: 2, max: 2, dayType: 'all' } },
    { id: 'n-n', type: 'codeCount', name: '護理大夜 N 每天 1～2 人', enabled: true, hard: true, weight: 50, params: { codes: ['N'], min: 1, max: 2, dayType: 'all' } },
    { id: 'n-n2', type: 'codeCount', name: '護理大夜 N 盡量排滿 2 人', enabled: true, hard: false, weight: 60, params: { codes: ['N'], min: 2, max: null, dayType: 'all' } },
    { id: 'c-d', type: 'codeCount', name: '照服日班 D8 每天 8～9 人', enabled: true, hard: true, weight: 50, params: { codes: ['D8'], min: 8, max: 9, dayType: 'all' } },
    { id: 'c-d9', type: 'codeCount', name: '照服日班 D8 盡量排滿 9 人', enabled: true, hard: false, weight: 40, params: { codes: ['D8'], min: 9, max: null, dayType: 'all' } },
    { id: 'c-n', type: 'codeCount', name: '照服夜班 N8 每天 7 人', enabled: true, hard: true, weight: 50, params: { codes: ['N8'], min: 7, max: 7, dayType: 'all' } },
    { id: 'rest', type: 'minRest', name: '輪班間隔至少 11 小時', enabled: true, hard: true, weight: 50, params: { hours: 11 } },
    { id: 'consec', type: 'maxConsec', name: '連續上班最多 6 天', enabled: true, hard: true, weight: 50, params: { group: 'all', days: 6 } },
    { id: 'consec-n', type: 'maxConsec', name: '護理盡量不連上超過 5 天', enabled: true, hard: false, weight: 15, params: { group: 'nurse', days: 5 } },
    { id: 'consec-c', type: 'maxConsec', name: '照服盡量不連上超過 4 天', enabled: true, hard: false, weight: 15, params: { group: 'care', days: 4 } },
    { id: 'quota', type: 'offQuota', name: '每月休假天數', enabled: true, hard: true, weight: 50, params: { mode: 'calendar', fixed: 10, extraWeight: 5 } },
    { id: 'leave', type: 'leaveOff', name: '預假必休', enabled: true, hard: true, weight: 50, params: {} },
    { id: 'prefer', type: 'preferShift', name: '依主要班別排', enabled: true, hard: false, weight: 8, params: {} },
    { id: 'fair-work', type: 'fairWork', name: '上班天數平均', enabled: true, hard: false, weight: 12, params: {} },
    { id: 'fair-shift', type: 'fairShift', name: '各班次數平均', enabled: true, hard: false, weight: 2, params: { codes: ['D', 'E', 'N', 'D8', 'N8'] } },
    { id: 'fair-weekend', type: 'fairWeekend', name: '假日休假平均', enabled: true, hard: false, weight: 6, params: {} },
    { id: 'few-changes', type: 'fewChanges', name: '減少換班', enabled: true, hard: false, weight: 3, params: {} },
    { id: 'isolated', type: 'isolatedWork', name: '避免只上一天班', enabled: true, hard: false, weight: 4, params: {} },
  ];

  // ── 假日 ─────────────────────────────────────────────────
  // 115 年：沿用舊系統行事曆，加上 9 月班表印證的 9/28 教師節與 10/26 光復節補假。
  // 機構行事曆若不同，可在設定頁增減。
  const HOLIDAYS_2026 = {
    '01-01': '元旦', '02-15': '小年夜', '02-16': '除夕', '02-17': '春節', '02-18': '春節', '02-19': '春節', '02-20': '春節',
    '02-28': '和平紀念日', '04-03': '兒童節補假', '04-04': '兒童節', '04-05': '清明節', '05-01': '勞動節', '06-19': '端午節',
    '09-25': '中秋節', '09-28': '教師節', '10-09': '國慶日補假', '10-10': '國慶日', '10-25': '光復節', '10-26': '光復節補假', '12-25': '行憲紀念日',
  };
  const HOLIDAYS_FIXED = { '01-01': '元旦', '02-28': '和平紀念日', '04-04': '兒童節', '05-01': '勞動節', '09-28': '教師節', '10-10': '國慶日', '10-25': '光復節', '12-25': '行憲紀念日' };
  const pad = n => String(n).padStart(2, '0');
  function holidaysFor(year, custom) {
    const base = year === 2026 ? HOLIDAYS_2026 : HOLIDAYS_FIXED;
    const map = {};
    Object.keys(base).forEach(k => { map[`${year}-${k}`] = base[k]; });
    Object.keys(custom || {}).forEach(k => {
      if (!k.startsWith(year + '-')) return;
      if (custom[k] === null || custom[k] === false) delete map[k]; else map[k] = custom[k] || '假日';
    });
    return map;
  }
  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

  // ── 亂數（固定種子，同樣條件會排出同一份班表）──────────────
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const has = v => v != null && v !== '';

  // ── 建立運算環境 ──────────────────────────────────────────
  // input: { year, month, staff, shifts, groups, rules, requests:{id:[day0,…]}, locks:{id:{day0:code}},
  //          prevTail:{id:[上月最後幾天的班別]}, holidays:{'YYYY-MM-DD':名稱} }
  // staff: { id, name, group, counted(預設 true), allowed:[班別], prefer:[主要班別], active }
  function buildContext(input) {
    const { year, month } = input;
    const dim = daysInMonth(year, month);
    const hol = holidaysFor(year, input.holidays);
    const days = [];
    for (let d = 0; d < dim; d++) {
      const wd = new Date(year, month - 1, d + 1).getDay();
      const hname = hol[`${year}-${pad(month)}-${pad(d + 1)}`] || '';
      days.push({ d, wd, holiday: !!hname, holidayName: hname, rest: wd === 0 || wd === 6 || !!hname });
    }
    const shifts = (input.shifts || DEFAULT_SHIFTS).map(s => Object.assign({}, s));
    const shiftMap = {};
    shifts.forEach(s => { shiftMap[s.code] = s; });
    const isWork = c => !!(shiftMap[c] && shiftMap[c].kind === 'work');
    const groups = input.groups || DEFAULT_GROUPS;
    const groupCodes = g => shifts.filter(s => s.kind === 'work' && (!s.group || s.group === g)).map(s => s.code);

    const staff = (input.staff || []).filter(s => s.active !== false).map(s => {
      const group = s.group || groups[0].id;
      const allowed = (s.allowed && s.allowed.length ? s.allowed : groupCodes(group)).filter(isWork);
      const autoCodes = allowed.filter(c => shiftMap[c].enabled !== false);
      const prefer = (s.prefer || []).filter(c => allowed.includes(c));
      return { id: s.id, name: s.name, group, counted: s.counted !== false, allowed, allowedSet: new Set(allowed), autoCodes, prefer, preferSet: new Set(prefer) };
    });
    const idIndex = {};
    staff.forEach((s, i) => { idIndex[s.id] = i; });

    const R = {};
    Object.keys(RULE_TYPES).forEach(t => { R[t] = []; });
    (input.rules || DEFAULT_RULES).forEach(r => {
      if (!r.enabled || !RULE_TYPES[r.type]) return;
      const hard = !!r.hard && !RULE_TYPES[r.type].softOnly;
      R[r.type].push({ id: r.id, type: r.type, name: r.name, hard, cost: hard ? HARD : Math.max(0, +r.weight || 0), p: r.params || {} });
    });

    const requests = {}, locks = {}, prev = {};
    staff.forEach(s => {
      requests[s.id] = new Set(((input.requests || {})[s.id] || []).map(Number).filter(d => d >= 0 && d < dim));
      locks[s.id] = Object.assign({}, (input.locks || {})[s.id] || {});
      prev[s.id] = ((input.prevTail || {})[s.id] || []).slice(-7);
    });

    // 每人應休天數
    const calendarOff = days.filter(x => x.rest).length;
    const qr = R.offQuota[0];
    const quota = qr ? (qr.p.mode === 'fixed' ? Math.max(0, +qr.p.fixed || 0) : calendarOff) : null;

    // 個人規則依人分組，檢核時不用每次全掃
    const pins = staff.map(() => []), counts = staff.map(() => []), consec = staff.map(() => []);
    R.weekdayPin.forEach(r => { const i = idIndex[r.p.staff]; if (i != null) pins[i].push(r); });
    R.staffCount.forEach(r => { const i = idIndex[r.p.staff]; if (i != null) counts[i].push(r); });
    R.maxConsec.forEach(r => { staff.forEach((s, i) => { if (!r.p.group || r.p.group === 'all' || r.p.group === s.group) consec[i].push(r); }); });

    // 公平性比較的對象：同組、計入人力的人
    const groupIdx = groups.map(g => staff.map((s, i) => (s.group === g.id && s.counted ? i : -1)).filter(i => i >= 0)).filter(a => a.length >= 2);
    const fairSets = [];
    R.fairShift.forEach(r => (r.p.codes || []).forEach(code => {
      const idx = staff.map((s, i) => (s.counted && !s.prefer.length && s.allowedSet.has(code) ? i : -1)).filter(i => i >= 0);
      if (idx.length >= 2) fairSets.push({ r, code, idx });
    }));

    const ctx = { year, month, dim, days, shifts, shiftMap, isWork, groups, staff, idIndex, R, requests, locks, prev, quota, calendarOff, pins, counts, consec, groupIdx, fairSets };
    ctx.dayMatch = (dayType, d) => !dayType || dayType === 'all' || (dayType === 'holiday' ? days[d].rest : !days[d].rest);
    return ctx;
  }

  function gapOf(v, min, max) {
    if (has(min) && v < +min) return +min - v;
    if (has(max) && v > +max) return v - +max;
    return 0;
  }
  function rangeText(min, max) {
    if (has(min) && has(max)) return +min === +max ? `需恰好 ${min}` : `需 ${min}～${max}`;
    return has(min) ? `需至少 ${min}` : `最多 ${max}`;
  }

  // ── 單日檢核：每日班別人數 ───────────────────────────────
  function evalDay(ctx, g, d, out) {
    const { staff, shiftMap, R } = ctx;
    const cnt = {};
    for (let i = 0; i < staff.length; i++) {
      if (!staff[i].counted) continue;
      const c = g[i][d], sh = shiftMap[c];
      if (sh && sh.kind === 'work') cnt[c] = (cnt[c] || 0) + 1;
    }
    let cost = 0;
    for (const r of R.codeCount) {
      if (!ctx.dayMatch(r.p.dayType, d)) continue;
      let v = 0;
      for (const c of r.p.codes || []) v += cnt[c] || 0;
      const gap = gapOf(v, r.p.min, r.p.max);
      if (gap > 0) {
        cost += gap * r.cost;
        if (out) out.push({ hard: r.hard, rule: r.id, day: d, codes: r.p.codes, msg: `${ctx.month}/${d + 1} ${(r.p.codes || []).join('/')} 共 ${v} 人，${rangeText(r.p.min, r.p.max)}` });
      }
    }
    return { cost, cnt };
  }

  // ── 單人檢核：可上班別、預假、間隔、連班、休假天數、個人規則 ──
  function evalPerson(ctx, i, row, out) {
    const { shiftMap, R, dim, days, month } = ctx;
    const p = ctx.staff[i], req = ctx.requests[p.id], tail = ctx.prev[p.id];
    const restRule = R.minRest[0], leaveRule = R.leaveOff[0];
    const changeRule = R.fewChanges[0], isoRule = R.isolatedWork[0], prefRule = p.prefer.length ? R.preferShift[0] : null;
    const consecRules = ctx.consec[i];
    let cost = 0;
    const cnt = {};
    let off = 0, restOff = 0;

    // 接續上個月月底：連班天數、最後一班、同班別連續天數
    let streak = 0, prevC = null;
    const runs = R.maxConsecCode.map(() => 0);
    for (const c of tail) {
      if (ctx.isWork(c)) {
        streak++; prevC = c;
        R.maxConsecCode.forEach((r, k) => { runs[k] = (r.p.codes || []).includes(c) ? runs[k] + 1 : 0; });
      } else { streak = 0; prevC = null; runs.fill(0); }
    }
    const who = p.name;

    for (let d = 0; d < dim; d++) {
      const c = row[d], sh = shiftMap[c], work = !!(sh && sh.kind === 'work');
      const label = `${month}/${d + 1}`;
      if (!sh && p.counted) {
        cost += HARD;
        if (out) out.push({ hard: true, rule: 'empty', staff: p.id, day: d, msg: `${who} ${label} 尚未排班` });
      }
      if (work) {
        cnt[c] = (cnt[c] || 0) + 1;
        if (!p.allowedSet.has(c)) {
          cost += HARD;
          if (out) out.push({ hard: true, rule: 'allowed', staff: p.id, day: d, msg: `${who} ${label} 排了 ${c}，不在他的可上班別內` });
        }
        if (sh.enabled === false) {
          cost += HARD;
          if (out) out.push({ hard: true, rule: 'disabled', staff: p.id, day: d, msg: `${who} ${label} 排了 ${c}，這個班別目前停用` });
        }
        if (leaveRule && req.has(d)) {
          cost += leaveRule.cost;
          if (out) out.push({ hard: leaveRule.hard, rule: leaveRule.id, staff: p.id, day: d, msg: `${who} ${label} 有預假，卻排了 ${c}` });
        }
        if (prefRule && !p.preferSet.has(c)) {
          cost += prefRule.cost;
          if (out) out.push({ hard: false, rule: prefRule.id, staff: p.id, day: d, quiet: true, msg: `${who} ${label} 排 ${c}，不是主要班別 ${p.prefer.join('/')}` });
        }
        if (prevC) {
          const ps = shiftMap[prevC];
          if (restRule) {
            const rest = 24 + sh.start - ps.end;
            if (rest < restRule.p.hours) {
              cost += restRule.cost;
              if (out) out.push({ hard: restRule.hard, rule: restRule.id, staff: p.id, day: d, msg: `${who} ${d === 0 ? '上月底' : `${month}/${d}`} ${prevC} 接 ${label} ${c}，間隔只有 ${rest} 小時（需 ${restRule.p.hours}）` });
            }
          }
          if (changeRule && prevC !== c) {
            cost += changeRule.cost;
            if (out) out.push({ hard: false, rule: changeRule.id, staff: p.id, day: d, quiet: true, msg: `${who} ${label} 沒休假就從 ${prevC} 換成 ${c}` });
          }
        }
        streak++;
        for (const r of consecRules) {
          if (streak > r.p.days) {
            cost += r.cost;
            if (out) out.push({ hard: r.hard, rule: r.id, staff: p.id, day: d, msg: `${who} ${label} 已連續上班 ${streak} 天（上限 ${r.p.days}）` });
          }
        }
        for (let k = 0; k < runs.length; k++) {
          const r = R.maxConsecCode[k];
          if ((r.p.codes || []).includes(c)) {
            runs[k]++;
            if (runs[k] > r.p.days) {
              cost += r.cost;
              if (out) out.push({ hard: r.hard, rule: r.id, staff: p.id, day: d, msg: `${who} ${label} ${c} 已連 ${runs[k]} 天（上限 ${r.p.days}）` });
            }
          } else runs[k] = 0;
        }
        prevC = c;
      } else {
        off++;
        if (days[d].rest) restOff++;
        // 昨天是單獨一天班（前天休、今天休）
        if (isoRule && streak === 1 && d > 1 && p.counted) {
          cost += isoRule.cost;
          if (out) out.push({ hard: false, rule: isoRule.id, staff: p.id, day: d - 1, quiet: true, msg: `${who} ${month}/${d} 前後都休，只上一天班` });
        }
        streak = 0; prevC = null;
        for (let k = 0; k < runs.length; k++) runs[k] = 0;
      }
      // 固定星期班別
      for (const r of ctx.pins[i]) {
        if (!(r.p.weekdays || []).includes(days[d].wd)) continue;
        if (r.p.skipHolidays && days[d].holiday) continue;
        if (req.has(d)) continue;      // 預假優先
        if (c !== r.p.code) {
          cost += r.cost;
          if (out) out.push({ hard: r.hard, rule: r.id, staff: p.id, day: d, msg: `${who} ${label}（週${WD[days[d].wd]}）應為 ${r.p.code}，目前是 ${c || '空白'}` });
        }
      }
    }

    // 每月休假天數（不計人力者不檢查）
    const qr = R.offQuota[0];
    if (qr && ctx.quota != null && p.counted) {
      if (off < ctx.quota) {
        cost += (ctx.quota - off) * qr.cost;
        if (out) out.push({ hard: qr.hard, rule: qr.id, staff: p.id, msg: `${who} 本月休 ${off} 天，少於應休 ${ctx.quota} 天` });
      } else if (off > ctx.quota) cost += (off - ctx.quota) * Math.max(0, +qr.p.extraWeight || 0);
    }
    for (const r of ctx.counts[i]) {
      let v = 0;
      for (const c of r.p.codes || []) v += cnt[c] || 0;
      const gap = gapOf(v, r.p.min, r.p.max);
      if (gap > 0) {
        cost += gap * r.cost;
        if (out) out.push({ hard: r.hard, rule: r.id, staff: p.id, msg: `${who} 本月 ${(r.p.codes || []).join('/')} 共 ${v} 次，${rangeText(r.p.min, r.p.max)}` });
      }
    }
    for (const r of R.avoidCode) {
      let v = 0;
      for (const c of r.p.codes || []) v += cnt[c] || 0;
      if (v > 0) {
        cost += v * r.cost;
        if (out) out.push({ hard: false, rule: r.id, staff: p.id, msg: `${who} 本月排了 ${v} 次 ${(r.p.codes || []).filter(c => cnt[c]).join('/')}` });
      }
    }
    return { cost, cnt, off, restOff, work: dim - off };
  }

  // ── 公平性：跨人比較 ─────────────────────────────────────
  function spread(ctx, idx, val, weight, out, mk) {
    let sum = 0;
    for (const i of idx) sum += val(i);
    const mean = sum / idx.length;
    let sq = 0, lo = Infinity, hi = -Infinity, loI = -1, hiI = -1;
    for (const i of idx) {
      const v = val(i);
      sq += (v - mean) * (v - mean);
      if (v < lo) { lo = v; loI = i; }
      if (v > hi) { hi = v; hiI = i; }
    }
    if (out && hi - lo >= 3) out.push(mk(ctx.staff[hiI].name, hi, ctx.staff[loI].name, lo));
    return sq * weight;
  }
  function evalFair(ctx, stats, out) {
    const { R } = ctx;
    let cost = 0;
    for (const f of ctx.fairSets) {
      cost += spread(ctx, f.idx, i => stats[i].cnt[f.code] || 0, f.r.cost, out,
        (a, hi, b, lo) => ({ hard: false, rule: f.r.id, msg: `${f.code} 次數不平均：${a} ${hi} 次、${b} ${lo} 次` }));
    }
    for (const r of R.fairWork) for (const idx of ctx.groupIdx) {
      cost += spread(ctx, idx, i => stats[i].work, r.cost, out,
        (a, hi, b, lo) => ({ hard: false, rule: r.id, msg: `上班天數不平均：${a} ${hi} 天、${b} ${lo} 天` }));
    }
    for (const r of R.fairWeekend) for (const idx of ctx.groupIdx) {
      cost += spread(ctx, idx, i => stats[i].restOff, r.cost, out,
        (a, hi, b, lo) => ({ hard: false, rule: r.id, msg: `假日休假不平均：${a} ${hi} 天、${b} ${lo} 天` }));
    }
    return cost;
  }

  function toGrid(ctx, cells) {
    return ctx.staff.map(s => {
      const row = (cells && cells[s.id]) || [];
      const a = new Array(ctx.dim);
      for (let d = 0; d < ctx.dim; d++) a[d] = row[d] || '';
      return a;
    });
  }
  function fromGrid(ctx, g) {
    const cells = {};
    ctx.staff.forEach((s, i) => { cells[s.id] = g[i].slice(); });
    return cells;
  }

  // ── 檢核整份班表 ─────────────────────────────────────────
  function validate(ctx, cells) {
    const g = toGrid(ctx, cells);
    const out = [];
    let score = 0;
    const dayCnt = [];
    for (let d = 0; d < ctx.dim; d++) { const r = evalDay(ctx, g, d, out); score += r.cost; dayCnt.push(r.cnt); }
    const stats = [];
    for (let i = 0; i < ctx.staff.length; i++) { const r = evalPerson(ctx, i, g[i], out); score += r.cost; stats.push(r); }
    score += evalFair(ctx, stats, out);
    const hard = out.filter(v => v.hard), soft = out.filter(v => !v.hard);
    const byId = {};
    ctx.staff.forEach((s, i) => { byId[s.id] = stats[i]; });
    return { score: Math.round(score), exact: score, hard, soft, violations: out, stats: byId, dayCnt, quota: ctx.quota };
  }

  // ── 人力試算：排之前先看人夠不夠 ─────────────────────────
  // 每組：需求＝每日班別人數的硬性下限加總；供給＝計入人力的人數 ×（當月天數 − 應休天數）
  function capacity(ctx) {
    return ctx.groups.map(g => {
      const codes = ctx.shifts.filter(s => s.kind === 'work' && s.group === g.id).map(s => s.code);
      let need = 0, full = 0;
      for (let d = 0; d < ctx.dim; d++) {
        const lo = {}, hi = {};
        for (const r of ctx.R.codeCount) {
          const cs = r.p.codes || [];
          if (cs.length !== 1 || !codes.includes(cs[0]) || !ctx.dayMatch(r.p.dayType, d) || !has(r.p.min)) continue;
          if (r.hard) lo[cs[0]] = Math.max(lo[cs[0]] || 0, +r.p.min);
          hi[cs[0]] = Math.max(hi[cs[0]] || 0, +r.p.min);
        }
        codes.forEach(c => { need += lo[c] || 0; full += hi[c] || 0; });
      }
      const people = ctx.staff.filter(s => s.group === g.id && s.counted).length;
      const supply = people * (ctx.dim - (ctx.quota || 0));
      return { id: g.id, name: g.name, people, need, full, supply, quota: ctx.quota };
    });
  }

  // ── 自動排班 ─────────────────────────────────────────────
  // opts: { seed, restarts, iterations }
  function solve(ctx, opts) {
    opts = opts || {};
    const { staff, dim, shiftMap } = ctx;
    const n = staff.length;
    if (!n) return { cells: {}, result: validate(ctx, {}) };

    // 固定格：鎖定格、預假（預假必休為硬性時）、硬性的固定星期班別；不計人力者只排固定班
    const fixed = staff.map(() => new Array(dim).fill(null));
    const leaveHard = ctx.R.leaveOff[0] && ctx.R.leaveOff[0].hard;
    staff.forEach((s, i) => {
      for (let d = 0; d < dim; d++) {
        const lk = ctx.locks[s.id][d];
        if (lk && shiftMap[lk]) { fixed[i][d] = lk; continue; }
        if (leaveHard && ctx.requests[s.id].has(d)) { fixed[i][d] = OFF; continue; }
        if (!s.counted) fixed[i][d] = '';
        for (const r of ctx.pins[i]) {
          if ((r.hard || !s.counted) && (r.p.weekdays || []).includes(ctx.days[d].wd) && !(r.p.skipHolidays && ctx.days[d].holiday) && shiftMap[r.p.code]) fixed[i][d] = r.p.code;
        }
      }
    });
    const free = [];
    for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) if (fixed[i][d] === null && staff[i].autoCodes.length) free.push(i * 64 + d);
    const restarts = opts.restarts || 3;
    const iters = opts.iterations || Math.max(60000, Math.min(450000, free.length * 400));

    const restH = ctx.R.minRest[0] ? ctx.R.minRest[0].p.hours : 0;
    const maxC = staff.map((s, i) => ctx.consec[i].reduce((a, r) => Math.min(a, r.p.days), 99));
    const workTarget = dim - (ctx.quota == null ? Math.round(dim * 2 / 7) : ctx.quota);
    const restOk = (prevC, c) => !prevC || !ctx.isWork(prevC) || 24 + shiftMap[c].start - shiftMap[prevC].end >= restH;

    // 每天每個班別要補到幾人（取該班別所有人數規則中最高的下限），晚的班先排
    const targetCodes = ctx.shifts.filter(s => s.kind === 'work' && s.enabled !== false).sort((a, b) => b.start - a.start).map(s => s.code);
    function target(code, d) {
      let t = 0;
      for (const r of ctx.R.codeCount) {
        const cs = r.p.codes || [];
        if (cs.length === 1 && cs[0] === code && ctx.dayMatch(r.p.dayType, d) && has(r.p.min)) t = Math.max(t, +r.p.min);
      }
      return t;
    }

    // 起始班表：逐日把各班補到目標人數，優先挑「還欠最多班」、能接班、又是主要班別的人
    function initial(rng) {
      const g = staff.map((s, i) => fixed[i].map(v => v === null ? OFF : v));
      const worked = new Array(n).fill(0), streak = new Array(n).fill(0);
      staff.forEach((s, i) => { for (const c of ctx.prev[s.id]) streak[i] = ctx.isWork(c) ? streak[i] + 1 : 0; });
      for (let d = 0; d < dim; d++) {
        for (const code of targetCodes) {
          let have = 0;
          for (let i = 0; i < n; i++) if (staff[i].counted && g[i][d] === code) have++;
          const need = target(code, d);
          while (have < need) {
            let best = -1, bestScore = -Infinity;
            for (let i = 0; i < n; i++) {
              const s = staff[i];
              if (fixed[i][d] !== null || g[i][d] !== OFF || !s.counted || !s.autoCodes.includes(code)) continue;
              if (streak[i] >= maxC[i]) continue;
              const prevC = d === 0 ? ctx.prev[s.id][ctx.prev[s.id].length - 1] : g[i][d - 1];
              if (!restOk(prevC, code)) continue;
              const sc = (workTarget - worked[i]) / Math.max(1, dim - d) * 10 + (prevC === code ? 1.5 : 0)
                + (s.prefer.length ? (s.preferSet.has(code) ? 3 : -3) : 0) + rng() * 1.5;
              if (sc > bestScore) { bestScore = sc; best = i; }
            }
            if (best < 0) break;
            g[best][d] = code; have++;
          }
        }
        for (let i = 0; i < n; i++) {
          if (ctx.isWork(g[i][d])) { worked[i]++; streak[i]++; } else streak[i] = 0;
        }
      }
      return g;
    }

    function anneal(seed) {
      const rng = mulberry32(seed);
      const g = initial(rng);
      const dayC = new Array(dim), perC = new Array(n), stats = new Array(n);
      let total = 0;
      for (let d = 0; d < dim; d++) { dayC[d] = evalDay(ctx, g, d).cost; total += dayC[d]; }
      for (let i = 0; i < n; i++) { stats[i] = evalPerson(ctx, i, g[i]); perC[i] = stats[i].cost; total += perC[i]; }
      let fairC = evalFair(ctx, stats); total += fairC;
      let best = total, bestG = g.map(r => r.slice());
      if (!free.length) return { g: bestG, score: best };

      const T0 = 30, T1 = 0.25;
      for (let it = 0; it < iters; it++) {
        const T = T0 * Math.pow(T1 / T0, it / iters);
        const key = free[(rng() * free.length) | 0], i = key >> 6, d = key & 63;
        const old = g[i][d];
        let j = -1, oldJ = null;
        if (rng() < 0.4) {
          // 同一天兩個人互換
          j = (rng() * n) | 0;
          if (j === i || fixed[j][d] !== null || g[j][d] === old) continue;
          oldJ = g[j][d];
          if (ctx.isWork(oldJ) && !staff[i].allowedSet.has(oldJ)) continue;
          if (ctx.isWork(old) && !staff[j].allowedSet.has(old)) continue;
          g[i][d] = oldJ; g[j][d] = old;
        } else {
          const codes = staff[i].autoCodes;
          const pick = (rng() * (codes.length + 1)) | 0;
          const nc = pick === codes.length ? OFF : codes[pick];
          if (nc === old) continue;
          g[i][d] = nc;
        }
        const nd = evalDay(ctx, g, d).cost;
        const si = evalPerson(ctx, i, g[i]);
        const sj = j >= 0 ? evalPerson(ctx, j, g[j]) : null;
        const keepI = stats[i], keepJ = j >= 0 ? stats[j] : null;
        stats[i] = si; if (sj) stats[j] = sj;
        const nf = evalFair(ctx, stats);
        const delta = (nd - dayC[d]) + (si.cost - perC[i]) + (sj ? sj.cost - perC[j] : 0) + (nf - fairC);
        if (delta <= 0 || rng() < Math.exp(-delta / T)) {
          dayC[d] = nd; perC[i] = si.cost; if (sj) perC[j] = sj.cost; fairC = nf; total += delta;
          if (total < best - 1e-9) { best = total; bestG = g.map(r => r.slice()); }
        } else {
          g[i][d] = old; stats[i] = keepI;
          if (j >= 0) { g[j][d] = oldJ; stats[j] = keepJ; }
        }
      }
      return { g: bestG, score: best };
    }

    let best = null;
    const base = opts.seed == null ? 13 : opts.seed;
    for (let r = 0; r < restarts; r++) {
      const res = anneal(base + r * 7919);
      if (!best || res.score < best.score) best = res;
      if (best.score < 1) break;
    }
    const cells = labelOffs(ctx, fromGrid(ctx, best.g));
    return { cells, result: validate(ctx, cells), iterations: iters };
  }

  // ── 休假標記 ─────────────────────────────────────────────
  // 國＝當月落在平日的國定假日數，例＝週日數，休＝週六數，超出的標 OF。
  // 例、休盡量一週各一個；鎖定格保留原本的標記。不計人力者沒上班的日子留白。
  function labelOffs(ctx, cells) {
    const L = OFF_LABELS;
    const ok = c => ctx.shiftMap[c] && ctx.shiftMap[c].kind === 'off' && ctx.shiftMap[c].enabled !== false;
    const nH = ok(L.holiday) ? ctx.days.filter(x => x.holiday && x.wd !== 0 && x.wd !== 6).length : 0;
    const nL = ok(L.weekly) ? ctx.days.filter(x => x.wd === 0).length : 0;
    const nR = ok(L.rest) ? ctx.days.filter(x => x.wd === 6).length : 0;
    const out = {};
    ctx.staff.forEach(s => {
      const row = (cells[s.id] || []).slice();
      while (row.length < ctx.dim) row.push('');
      const offDays = [];
      let h = 0, l = 0, r = 0;
      for (let d = 0; d < ctx.dim; d++) {
        if (ctx.isWork(row[d])) continue;
        if (!s.counted) { if (!ctx.locks[s.id][d]) row[d] = ''; continue; }
        if (ctx.locks[s.id][d] && row[d]) {                    // 鎖定格算進已用額度
          if (row[d] === L.holiday) h++; else if (row[d] === L.weekly) l++; else if (row[d] === L.rest) r++;
          continue;
        }
        row[d] = OFF; offDays.push(d);
      }
      const used = new Set();
      const put = (d, code) => { row[d] = code; used.add(d); };
      for (const d of offDays) if (h < nH && ctx.days[d].holiday) { put(d, L.holiday); h++; }
      // 每週先給一個例假、一個休息日
      const mon = (ctx.days[0].wd + 6) % 7;                    // 1 號距離週一幾天
      const week = d => Math.floor((d + mon) / 7);
      const weeks = {};
      offDays.forEach(d => { if (!used.has(d)) (weeks[week(d)] = weeks[week(d)] || []).push(d); });
      Object.keys(weeks).forEach(w => {
        const ds = weeks[w];
        const sun = ds.find(d => ctx.days[d].wd === 0);
        const first = sun != null ? sun : ds[ds.length - 1];
        if (l < nL && first != null) { put(first, L.weekly); l++; }
        const second = ds.find(d => !used.has(d));
        if (r < nR && second != null) { put(second, L.rest); r++; }
      });
      for (const d of offDays) if (!used.has(d) && l < nL) { put(d, L.weekly); l++; }
      for (const d of offDays) if (!used.has(d) && r < nR) { put(d, L.rest); r++; }
      for (const d of offDays) if (!used.has(d) && h < nH) { put(d, L.holiday); h++; }
      out[s.id] = row;
    });
    return out;
  }

  return {
    HARD, OFF, OFF_LABELS, WD, RULE_TYPES, DEFAULT_GROUPS, DEFAULT_SHIFTS, DEFAULT_RULES,
    daysInMonth, holidaysFor, buildContext, validate, solve, labelOffs, capacity,
  };
});
