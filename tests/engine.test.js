// 引擎測試：node tests/engine.test.js
const E = require('../engine.js');
const SEED = require('../seed.js');
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };
const rules = extra => JSON.parse(JSON.stringify(E.DEFAULT_RULES)).concat(SEED.rules, extra || []);
const sept = SEED.months['2026_9'].cells;
const tail = {};
Object.keys(sept).forEach(id => { tail[id] = sept[id].slice(-7); });
const show = (ctx, cells) => ctx.staff.forEach(s => console.log('    ' + s.name.padEnd(4, '　') + ' ' + cells[s.id].map(c => (c || '·').padEnd(2)).join(' ')));
const summary = r => `分數 ${r.score}，硬性違規 ${r.hard.length}，提醒 ${r.soft.filter(v => !v.quiet).length}`;

console.log('1. 用預設規則檢核 9 月實際班表（規則應該與機構現行排法相容）');
{
  const ctx = E.buildContext({ year: 2026, month: 9, staff: SEED.staff, rules: rules() });
  const r = E.validate(ctx, sept);
  console.log('    ' + summary(r));
  r.hard.forEach(v => console.log('    ! ' + v.msg));
  ok(ctx.quota === 10, '9 月應休 10 天（與班表抬頭一致）');
  ok(r.hard.length === 0, '實際班表沒有硬性違規');
  E.capacity(ctx).forEach(c => console.log(`    ${c.name}：${c.people} 人，可上班 ${c.supply} 人日，最低需求 ${c.need}，排滿需求 ${c.full}`));
}

console.log('2. 自動排 115 年 10 月（接續 9 月月底，含預假）');
let oct;
{
  const requests = { n01: [2, 3, 4], n03: [16, 17], c08: [9, 10, 11], c21: [23, 24], c24: [0, 1] };
  const ctx = E.buildContext({ year: 2026, month: 10, staff: SEED.staff, rules: rules(), requests, prevTail: tail });
  const t = Date.now();
  const { cells, result, iterations } = E.solve(ctx, { seed: 1 });
  oct = { ctx, cells, result };
  console.log(`    用時 ${Date.now() - t} ms（${iterations} 次嘗試 × 3 個起點），${summary(result)}`);
  show(ctx, cells);
  result.hard.forEach(v => console.log('    ! ' + v.msg));
  result.soft.filter(v => !v.quiet).slice(0, 12).forEach(v => console.log('    · ' + v.msg));
  ok(result.hard.length === 0, '沒有硬性違規');
  ok(Object.keys(requests).every(id => requests[id].every(d => !ctx.isWork(cells[id][d]))), '預假都有排休');
  ok(result.dayCnt.every(c => c.D === 2 && c.E === 2 && c.N >= 1 && c.N <= 2), '護理每天 D 2、E 2、N 1～2');
  ok(result.dayCnt.every(c => c.D8 >= 8 && c.D8 <= 9 && c.N8 === 7), '照服每天 D8 8～9、N8 7');
  ok(ctx.staff.filter(s => s.counted).every(s => result.stats[s.id].off >= ctx.quota), `每人休假不少於 ${ctx.quota} 天`);
  const pt = cells.n10;
  ok(pt.every((c, d) => ([1, 3, 5].includes(ctx.days[d].wd) ? c === 'D' : c === '')), '兼職只在週一三五排 D，其餘留白');
  const w = ctx.staff.filter(s => s.group === 'care').map(s => result.stats[s.id].work);
  console.log(`    照服上班天數：${Math.min(...w)}～${Math.max(...w)}`);
  ok(Math.max(...w) - Math.min(...w) <= 2, '照服上班天數差距不超過 2 天');
  const pref = ctx.staff.filter(s => s.prefer.length);
  const hit = pref.reduce((a, s) => a + (result.stats[s.id].cnt[s.prefer[0]] || 0), 0), all = pref.reduce((a, s) => a + result.stats[s.id].work, 0);
  console.log(`    有主要班別的人，${Math.round(hit / all * 100)}% 的班排在主要班別`);
  ok(hit / all >= 0.75, '主要班別大致被尊重');
}

console.log('3. 檢核能抓到手動改出來的違規');
{
  const ctx = E.buildContext({ year: 2026, month: 10, staff: SEED.staff, rules: rules(), requests: { n02: [5] }, prevTail: tail });
  const cells = JSON.parse(JSON.stringify(oct.cells));
  cells.n02[3] = 'N'; cells.n02[4] = 'D';      // 大夜接白班
  cells.n02[5] = 'E';                          // 預假日上班
  cells.c01[8] = 'D';                          // 照服排護理班
  for (let d = 12; d < 20; d++) cells.c02[d] = 'D8';
  const r = E.validate(ctx, cells);
  const hit = re => r.hard.some(v => re.test(v.msg));
  ok(hit(/黃珮榛.*間隔只有 0 小時/), '大夜接白班 → 間隔不足');
  ok(hit(/黃珮榛.*有預假/), '預假日排班 → 抓到');
  ok(hit(/阮氏青海.*不在他的可上班別內/), '照服排到護理班別 → 抓到');
  ok(hit(/盧莉佳娜.*連續上班 7 天/), '連上 7 天 → 抓到');
  ok(hit(/D8 共 \d+ 人/), '照服日班人數超出 → 抓到');
}

console.log('4. 鎖定格保留、同條件重排結果相同');
{
  const input = { year: 2026, month: 10, staff: SEED.staff.filter(s => s.group === 'nurse'), rules: rules(), prevTail: tail,
    locks: { n05: { 9: 'N', 10: '例' } } };
  const a = E.solve(E.buildContext(input), { seed: 3 }), b = E.solve(E.buildContext(input), { seed: 3 });
  ok(a.cells.n05[9] === 'N' && a.cells.n05[10] === '例', '鎖定格原樣保留');
  ok(JSON.stringify(a.cells) === JSON.stringify(b.cells), '同樣條件重排，結果相同');
}

console.log('5. 休假標記');
{
  const row = oct.cells.n02, c = k => row.filter(x => x === k).length;
  console.log(`    例 ${c('例')}、休 ${c('休')}、國 ${c('國')}、OF ${c('OF')}`);
  ok(c('例') === 4 && c('休') === 5 && c('國') === 2, '10 月：例 4（週日數）、休 5（週六數）、國 2（10/9、10/26）');
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
