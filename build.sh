#!/bin/bash
# Проставляет версию во все ссылки на файлы, чтобы браузер и PWA гарантированно
# подхватили обновление, а не показывали закэшированную старую версию.
set -e
cd "$(dirname "$0")"

# Сверка с оболочкой SW: всё, что страница грузит как модуль или стиль, должно
# быть в SHELL (sw.js) — иначе после обновления первый запуск без сети упадёт
# на импорте. Имена — только a-z, 0-9, - и _: другим версия ниже не проставится.
# Путь './x.js' из модуля в js/ — это js/x.js; из index.html — './js/x.js'.
if grep -nE "(from|import)[ (]*\"\./" index.html js/*.js >&2; then
  echo "Ошибка: импорты пишите в одинарных кавычках — в двойных версия не проставится" >&2
  exit 1
fi
missing=''
badname=''
for p in $( { grep -ohE "(from |import |import\()'\./[^'?]+" js/*.js | sed -E "s|^[^']*'\./|js/|"
              grep -ohE "(from |import |import\()'\./js/[^'?]+" index.html | sed -E "s|^[^']*'\./||"
              grep -ohE '(src="js|href="css)/[^"?]+' index.html | sed -E 's|^[a-z]+="||'
              echo css/style.css; } | sort -u ); do
  [[ "$p" =~ ^(js|css)/[a-z0-9_-]+\.(js|css)$ ]] || badname="$badname $p"
  grep -qF "'./$p'" sw.js || missing="$missing $p"
done
if [ -n "$badname" ]; then
  echo "Ошибка: модуль должен лежать прямо в js/ (стиль — в css/), в имени только a-z, 0-9, - и _ — иначе не проставится версия:$badname" >&2
  exit 1
fi
if [ -n "$missing" ]; then
  echo "Ошибка: этих файлов нет в списке SHELL в sw.js:$missing" >&2
  echo "Допишите их туда, иначе без сети приложение не откроется." >&2
  exit 1
fi
# И обратно: каждый файл из SHELL должен существовать — SW проваливает
# установку без страницы, стилей и модулей, и обновление встало бы навсегда.
gone=''
for p in $(sed -n "/^const SHELL = \[/,/^\];/p" sw.js | grep -oE "'\./[^']*'" | tr -d "'" | sed -E 's|^\./||'); do
  [ -z "$p" ] && p=index.html
  [ -f "$p" ] || gone="$gone $p"
done
if [ -n "$gone" ]; then
  echo "Ошибка: в SHELL в sw.js есть файлы, которых нет в репозитории:$gone" >&2
  exit 1
fi

V=$(date +%Y%m%d%H%M)

# index.html: стили, скрипты и импорты во встроенных модулях
sed -i '' -E "s|(href=\"css/[a-z0-9_-]+\.css)(\?v=[0-9]+)?\"|\1?v=$V\"|g" index.html
sed -i '' -E "s|(src=\"js/[a-z0-9_-]+\.js)(\?v=[0-9]+)?\"|\1?v=$V\"|g" index.html
sed -i '' -E "s#((from |import |import\()'\./js/[a-z0-9_-]+\.js)(\?v=[0-9]+)?'#\1?v=$V'#g" index.html

# внутренние импорты модулей: статические, побочные и динамические
for f in js/*.js; do
  sed -i '' -E "s#((from |import |import\()'\./[a-z0-9_-]+\.js)(\?v=[0-9]+)?'#\1?v=$V'#g" "$f"
done

# версия в настройках
sed -i '' -E "s|const VERSION = '[^']*';|const VERSION = '$V';|" js/app.js

# версия в service worker — новая версия = новый кэш
sed -i '' -E "s|const VERSION = '[^']*';|const VERSION = '$V';|" sw.js

# отдельный файл версии: приложение опрашивает его и обновляется само
printf '{"version":"%s"}\n' "$V" > version.json

echo "версия сборки: $V"
