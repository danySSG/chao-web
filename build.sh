#!/bin/bash
# Проставляет версию во все ссылки на файлы, чтобы браузер и PWA гарантированно
# подхватили обновление, а не показывали закэшированную старую версию.
set -e
cd "$(dirname "$0")"
V=$(date +%Y%m%d%H%M)

# index.html: css и точка входа js
sed -i '' -E "s|(href=\"css/style\.css)(\?v=[0-9]+)?\"|\1?v=$V\"|g" index.html
sed -i '' -E "s|(src=\"js/app\.js)(\?v=[0-9]+)?\"|\1?v=$V\"|g" index.html

# внутренние импорты модулей
for f in js/*.js; do
  sed -i '' -E "s|(from '\./[a-z]+\.js)(\?v=[0-9]+)?'|\1?v=$V'|g" "$f"
  sed -i '' -E "s|(import\('\./js/[a-z]+\.js)(\?v=[0-9]+)?'|\1?v=$V'|g" "$f"
done

# версия в настройках
sed -i '' -E "s|const VERSION = '[^']*';|const VERSION = '$V';|" js/app.js

# отдельный файл версии: приложение опрашивает его и обновляется само
printf '{"version":"%s"}\n' "$V" > version.json

echo "версия сборки: $V"
