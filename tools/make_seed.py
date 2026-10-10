"""把機構的 Excel 班表轉成 seed.js（人員名單 + 該月班表）。
用法：python3 tools/make_seed.py 班表.xlsx 2026 9 > seed.js
工作表「護理」「照服總」。主要班別：該月 80% 以上都上同一班的人。
加 --green-as-leave 會把綠底的休假格當成預假匯入（綠底的意義尚未向機構確認，預設不匯入）。
"""
import sys, json, collections, datetime, openpyxl
GREEN = '--green-as-leave' in sys.argv
path, year, month = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
wb = openpyxl.load_workbook(path)
SHEETS = [('護理', 'nurse', 'n', ['D', 'E', 'N']), ('照服總', 'care', 'c', ['D8', 'N8'])]
OFFS = {'例': '例', '休': '休', '國': '國', 'OF': 'OF', 'OFF': 'OF'}
staff, cells, requests, rules = [], {}, {}, []
for sheet, group, prefix, work in SHEETS:
    ws = wb[sheet]
    dim = sum(1 for c in range(3, 34) if isinstance(ws.cell(2, c).value, int))
    k = 0
    for r in range(4, ws.max_row + 1):
        name = ws.cell(r, 2).value
        if not isinstance(name, str) or not name.strip() or ws.cell(r, 1).value is None: continue
        name = name.strip()
        row, green = [], []
        for d in range(dim):
            cell = ws.cell(r, 3 + d)
            v = str(cell.value).strip() if cell.value is not None else ''
            v = v if v in work else OFFS.get(v, '')
            row.append(v)
            if v and v not in work and cell.fill and cell.fill.fill_type and cell.fill.fgColor.rgb == 'FF92D050': green.append(d)
        if not any(v in work for v in row): continue
        k += 1
        sid = f'{prefix}{k:02d}'
        blanks = row.count('')
        person = {'id': sid, 'name': name, 'group': group}
        cnt = collections.Counter(v for v in row if v in work)
        total = sum(cnt.values())
        if blanks > dim / 3:
            # 多數日子留白 → 不計人力的兼職，固定星期上班
            person['counted'] = False
            wds = collections.Counter()
            for d, v in enumerate(row):
                if v in work: wds[(datetime.date(year, month, d + 1).weekday() + 1) % 7] += 1
            code = cnt.most_common(1)[0][0]
            rules.append({'id': 'pin-' + sid, 'type': 'weekdayPin', 'name': f'{name} 固定星期班別', 'enabled': True, 'hard': True, 'weight': 50,
                          'params': {'staff': sid, 'weekdays': sorted(w for w, c in wds.items() if c >= 2), 'code': code, 'skipHolidays': False}})
        else:
            top, n = cnt.most_common(1)[0]
            if n / total >= 0.8: person['prefer'] = [top]
        staff.append(person); cells[sid] = row
        if green and GREEN: requests[sid] = green
seed = {'facility': '九德大愛護理之家', 'staff': staff, 'rules': rules, 'months': {f'{year}_{month}': {'cells': cells, 'requests': requests}}}
body = json.dumps(seed, ensure_ascii=False, separators=(',', ':'))
body = body.replace('},{"id"', '},\n{"id"').replace('],"', '],\n"')
print('/* 由 tools/make_seed.py 從機構班表產生：人員名單與 %d 年 %d 月實際班表。第一次開啟系統時載入。 */' % (year - 1911, month))
print('(function(r,s){if(typeof module==="object"&&module.exports)module.exports=s;else r.NH_SEED=s;})(typeof self!=="undefined"?self:this,')
print(body + ');')
