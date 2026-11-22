# Подключения очереди n8n

В [JarvisApp](https://t.me/assitant_ai_bot/JarvisApp) тестовый запуск обрабатывает задачу `TEST-1` в памяти. Fixture coder возвращает `PR_CREATED`. При следующем тестовом запуске задача снова имеет статус `NEW`.

| Узлы из queue_v9 | Поддержка в Jarvis |
|---|---|
| Cron v1, Error Trigger v1, NoOp v1 | Ручной старт от Cron, отдельная ветка ошибки, завершение пустой очереди. |
| Google Sheets v4 | Чтение листов и update строки по ID с маппингом колонок. |
| Code v2 | Синхронный JavaScript, `$input.all()`, `$input.first()`, `$json`, `$('имя').item`, `$('имя').all()` и разрешённый `$env`. Чтение листа передаёт массив в фильтр. Выбранные фильтром задачи проходят последующие операции по отдельности. |
| IF v2, Switch v3 | Строгие сравнения, именованные выходы Switch, дополнительный выход при отсутствии совпадения и несколько связей с одного выхода. |
| HTTP Request v4.2, Telegram v1.2 | JSON POST в coder и manager, DELETE сессии, сообщение об ошибке в настроенный чат. |

Live-запуск работает с листами `projects` и `tasks` таблицы `GOOGLE_SHEET_ID`, отправляет задачу в assistant-coder и может записать статус, удалить сессию coder или отправить уведомление. Для одной рабочей таблицы оставьте один активный обработчик очереди. Остановите прежний Cron в n8n до первого live-запуска Jarvis, иначе оба обработчика могут выбрать одну задачу.

## Credentials

Подготовьте JSON-массив из двух расшифрованных записей n8n. Для Google Sheets нужен тип `googleSheetsOAuth2Api` с `clientId`, `clientSecret` и `oauthTokenData.refresh_token`. Для Telegram нужен `telegramApi` с `accessToken`. Worker ищет credential по типу и ID из узла. Если ID при переносе изменился, worker ищет единственное совпадение типа и полного имени. При неоднозначности запуск завершится ошибкой.

Если готового экспорта нет, выполните следующие команды в каталоге assistant на Linux. Подставьте ID двух записей из вашей установки n8n. Для сборки массива требуется `jq`. Команды сохраняют credentials в файлы с приватными правами. [n8n Server CLI](https://docs.n8n.io/hosting/cli-commands/#export-workflows-and-credentials)

```sh
(
  set -eu
  umask 077
  dest="${HOME}/.local/share/jarvis/secrets"
  install -d -m 700 "$dest"
  staging=$(mktemp -d "$dest/export.XXXXXXXX")
  remote=$(docker compose exec -T -u node assistant-n8n mktemp -d /tmp/jarvis-export.XXXXXXXX)
  trap 'rm -rf -- "$staging"; docker compose exec -T -u node assistant-n8n rm -rf -- "$remote"' EXIT
  for pair in 'sheets:GOOGLE_CREDENTIAL_ID' 'telegram:TELEGRAM_CREDENTIAL_ID'; do
    name=${pair%%:*}
    id=${pair#*:}
    docker compose exec -T -u node assistant-n8n n8n export:credentials \
      --id="$id" --decrypted --output="$remote/$name.json"
    docker compose cp "assistant-n8n:$remote/$name.json" "$staging/$name.json"
  done
  jq -es 'add | select(length == 2)' "$staging/sheets.json" "$staging/telegram.json" > "$staging/credentials.json"
  chmod 400 "$staging/credentials.json"
  mv -- "$staging/credentials.json" "$dest/n8n-credentials.json"
)
```

Владелец файла должен совпадать с UID пользователя `node` в контейнере worker либо предоставить ему доступ на чтение через ACL. Образ Jarvis запускается от `node` (UID 1000 в стандартном образе). Храните файл вне Git и Docker build context. После повторной авторизации n8n обновите экспорт и пересоздайте worker, чтобы он получил новый файл.

## Docker Compose

Укажите в окружении Jarvis `JARVIS_N8N_HOST_CREDENTIALS_FILE` (абсолютный путь к JSON) и `JARVIS_ASSISTANT_NETWORK` (существующая сеть сервисов assistant-coder и assistant-n8n). Выполните команды из каталога Jarvis, указав файл окружения своего assistant. Флаг `--quiet` проверяет конфигурацию без вывода её значений.

```sh
docker compose --env-file /path/to/assistant/.env --env-file .env \
  -f compose.yaml -f compose.n8n.yaml config --quiet
docker compose --env-file /path/to/assistant/.env --env-file .env \
  -f compose.yaml -f compose.n8n.yaml up -d --build --wait
```

Если nginx подключается через `compose.proxy.yaml`, добавьте `-f compose.proxy.yaml` в обе команды. Overlay включает `JARVIS_N8N_LIVE_ENABLED=true` для app и worker. Доступ к credential export и сети assistant получает worker. Compose подставляет из файлов окружения выбранные по имени значения.

| Настройка | Использование |
| --- | --- |
| `GOOGLE_SHEET_ID`, `ADMIN_CHAT_ID` | Единственная таблица очереди и чат для ошибок. |
| `GITHUB_TOKEN`, `GITHUB_OWNER`, `PROJECT_REPO` | Токен по умолчанию и значения owner/repo, когда они отсутствуют в строке проекта. |
| `MAX_PARALLEL_TASKS`, `STALL_TIMEOUT_HOURS`, `MAX_STALL_RETRIES` | Параллелизм на проект, порог зависания и число повторов. |
| `JARVIS_N8N_CODER_ORIGIN` | По умолчанию `http://assistant-coder:3000`. Разрешены `POST /execute` и `DELETE /session/{taskId}`. |
| `JARVIS_N8N_MANAGER_ORIGIN` | По умолчанию `http://assistant-n8n:5678`. Разрешён `POST /webhook/manager-task-complete`. |
| `JARVIS_N8N_GIT_ORIGINS` | Дополнительные доверенные Git origin через запятую для проектов с собственным `BaseUrl`. По умолчанию доступны github.com и gitlab.com по HTTPS. |

Для проектов с `TokenEnvVar` добавьте переменные явно в локальный Compose override. Например, для проекта со значением `TEAM_GIT_TOKEN` передайте worker `TEAM_GIT_TOKEN: ${TEAM_GIT_TOKEN:?Set TEAM_GIT_TOKEN}` и `JARVIS_N8N_PROJECT_TOKEN_NAMES: TEAM_GIT_TOKEN`. Список допускает несколько имён через запятую. Code node получает ссылки на токены, действующие в пределах одного запуска. Worker заменяет ссылку значением при вызове `POST /execute`.

Google Sheets использует OAuth refresh и записывает только указанные ячейки совпавшей строки `tasks` с режимом `RAW`. Заголовки должны находиться в первой строке, а значение `ID` задачи должно быть уникальным. Telegram использует метод `sendMessage` с credential узла ошибок. Адреса API Google и Telegram зафиксированы, HTTP redirects отключены. [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server#offline) · [Google Sheets batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate) · [Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage)
