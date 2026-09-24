#!/usr/bin/env python3
"""Отчёт об использовании Chào по анонимному журналу установок.

Запуск на сервере:
    python3 /var/www/chao/.tools/installs.py [--mine НОМЕР1,НОМЕР2] [--days 14]

Свои установки (владельца и тестовые) перечисляются по одной в строке
в /root/chao-mine.txt — вне сайта и вне репозитория — и исключаются сами.

Журнал пишет nginx (формат chao_install в vhost chao): время, номер установки,
режим (a — установлено на экран, b — браузер), платформа (i — айфон/айпад,
a — андроид, d — компьютер), ключ (1 — введён), версия приложения.
IP-адресов и браузерных строк в журнале нет: связать номер с человеком нельзя.

Номер установки — это установка, а не человек: Safari и значок на экране
у айфона хранят данные раздельно, «Удалить всё» порождает новый номер.
"""
import collections
import datetime
import glob
import gzip
import sys

LOG = '/var/log/nginx/chao-installs.log*'
VN = datetime.timedelta(hours=7)          # дни считаем по вьетнамскому времени
PLATFORM = {'i': 'айфон', 'a': 'андроид', 'd': 'компьютер'}


def arg(name, default=''):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


MINE_FILE = '/root/chao-mine.txt'
mine = {x.strip() for x in arg('--mine').split(',') if x.strip()}
try:
    with open(MINE_FILE) as f:
        mine |= {line.split('#')[0].strip() for line in f if line.split('#')[0].strip()}
except OSError:
    pass
window = int(arg('--days', '0') or 0)

events = []
for path in sorted(glob.glob(LOG)):
    opener = gzip.open if path.endswith('.gz') else open
    with opener(path, 'rt', errors='replace') as f:
        for line in f:
            parts = line.split()
            if len(parts) < 6 or len(parts[1]) != 12:
                continue                   # запросы старых версий без номера
            try:
                when = datetime.datetime.fromisoformat(parts[0]) + VN
            except ValueError:
                continue
            events.append((when, *parts[1:6]))

if not events:
    sys.exit('Журнал пуст: установки ещё не отмечались.')

now = max(e[0] for e in events)
if window:
    events = [e for e in events if (now - e[0]).days < window]

per = collections.defaultdict(lambda: {'days': set(), 'runs': 0, 'key': False,
                                       'home': False, 'first': None, 'last': None})
for when, i, mode, plat, key, ver in sorted(events):
    c = per[i]
    c['days'].add(when.date())
    c['runs'] += 1
    c['key'] |= key == '1'
    c['home'] |= mode == 'a'
    c['plat'], c['ver'] = PLATFORM.get(plat, plat), ver
    c['first'] = c['first'] or when
    c['last'] = when

others = {i: c for i, c in per.items() if i not in mine}
first_day = min(e[0] for e in events).date()
print(f'Период: {first_day} — {now.date()} (время Вьетнама)')
if mine:
    print(f'Свои установки исключены: {len(per) - len(others)}')
print()


def count(pred):
    return sum(1 for c in others.values() if pred(c))


print(f'Установок:                    {len(others)}')
print(f'  дошли до рабочего ключа:    {count(lambda c: c["key"])}')
print(f'  открыли, но без ключа:      {count(lambda c: not c["key"])}')
print(f'  поставили на экран:         {count(lambda c: c["home"])}')
print(f'  возвращались (2+ дня):      {count(lambda c: len(c["days"]) > 1)}')
print(f'  активны за 7 дней:          {count(lambda c: (now - c["last"]).days < 7)}')
print(f'  новые за 7 дней:            {count(lambda c: (now - c["first"]).days < 7)}')
plats = collections.Counter(c['plat'] for c in others.values())
print('  платформы:                  ' + ', '.join(f'{p} {n}' for p, n in plats.most_common()))
print()
print('номер        платформа   экран ключ  дней запусков  первый     последний')
for i, c in sorted(others.items(), key=lambda x: (-len(x[1]['days']), -x[1]['runs'])):
    print(f'{i}  {c["plat"]:10}  {"да" if c["home"] else "—":5} {"да" if c["key"] else "—":5} '
          f'{len(c["days"]):4} {c["runs"]:8}  {c["first"]:%d.%m %H:%M} {c["last"]:%d.%m %H:%M}')
