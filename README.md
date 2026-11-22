# Jarvis

Jarvis — личный помощник в Telegram. Mini App показывает пользователю формы, варианты выбора и результаты. Интерфейс, backend, worker и PostgreSQL размещаются на публичном Ubuntu-сервере. Внешний адрес — [jarvis.ai.kilop.ru](https://jarvis.ai.kilop.ru/).

## Первый сценарий

На интеграционном стенде пользователь вводит название фильма, выбирает раздачу и получает подтверждение передачи файла в watch-папку uTorrent. Тот же Filmobot продолжает принимать команды в своём Telegram-чате. Здесь зафиксирован проект реализации. Примеры описывают целевой API и формат Jarvis v1.

| Что посмотреть | Файл |
|---|---|
| Архитектурное решение, подключение сервиса, контракт вызова | [Спецификация](docs/superpowers/specs/2026-11-22-service-contract.md) |
| Как указать адрес сервиса, credential и доступные операции | [Подключение Filmobot](examples/services/filmobot.connection.json) |
| Параметры поиска, выбор раздачи и ответ о передаче файла | [OpenAPI Filmobot](examples/services/filmobot.openapi.json) |
| Полный граф от поля поиска до результата | [Workflow «Найти и скачать фильм»](examples/workflows/cinema-search.json) |
| Очерёдность работ, зависимости и критерии приёмки | [План реализации](docs/superpowers/plans/2026-11-22-jarvis.md) |

## Проверить сценарий локально

Экран «Кино» в Mini App запускает граф через backend Jarvis. Чат Filmobot остаётся отдельным входом. Оба используют одну логику передачи раздачи с сохранением квитанции. Поиск можно продолжить из истории после закрытия приложения.

Из корня проекта с доступными Docker Compose и Make:

```sh
make validate
make test
make test-runner
make test-miniapp
make test-deploy
```

`make validate` читает подключение, OpenAPI Filmobot и граф кино. Успешный результат содержит две доступные операции и 11 проверенных узлов. Для своих файлов передай пути внутри проекта: `make validate CONNECTION=examples/services/filmobot.connection.json WORKFLOW=examples/workflows/cinema-search.json`. Файлы открываются только для чтения. Секреты, запущенный Filmobot и доступ к Telegram для этой команды не требуются. `make test` проверяет строгие типы TypeScript и запускает тесты в контейнере.

## Telegram Mini App на сервере

Ссылка запуска для пользователей — [JarvisApp в Telegram](https://t.me/assitant_ai_bot/JarvisApp). В настройках этой Mini App у BotFather укажите HTTPS-адрес корня Jarvis. На нём должны открываться и страница, и маршруты `/api/`. Для авторизации нужен токен владельца приложения — бота `@assitant_ai_bot`. [Проверка данных Telegram](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)

1. На Ubuntu создайте локальный `.env` по [.env.example](.env.example). Задайте `JARVIS_BOT_TOKEN`, числовые Telegram ID через запятую в `JARVIS_ALLOWED_USER_IDS` и пароль отдельной БД `JARVIS_DB_PASSWORD`.
2. Если nginx работает на хосте, запустите `docker compose up -d --build --wait`. Приложение по умолчанию доступно на `127.0.0.1:8080`. Для другого свободного порта задайте `JARVIS_PORT`. PostgreSQL хранит данные в именованном томе и доступен только внутри Docker.
3. Если nginx работает в контейнере, укажите имя его сети в `JARVIS_PROXY_NETWORK` и запустите `docker compose -f compose.yaml -f compose.proxy.yaml up -d --build --wait`. В этой сети приложение доступно как `jarvis-app:8080`.
4. В существующем TLS server block для `jarvis.ai.kilop.ru` переключите location заглушки на приложение. Пример для nginx на Ubuntu-хосте приведён ниже. Для контейнерного nginx upstream будет `http://jarvis-app:8080`. Проверьте конфигурацию nginx перед reload.

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

5. Проверьте `curl -fsS https://jarvis.ai.kilop.ru/health` (ожидается `{"ok":true}`), затем откройте JarvisApp в Telegram. Backend проверяет БД по маршруту `/health`, worker имеет собственный Docker healthcheck. Состояние контейнеров видно в `docker compose ps`.

Автономная установка Ubuntu запускается со своей внутренней сетью. После входа доступны главная и история. Экран «Кино» сообщает, что сервис поиска пока не подключён. Полный сценарий с записью файла включён в изолированной конфигурации тестов.

Backend проверяет HMAC и возраст `initData` (до 5 минут с допуском 30 секунд для часов в будущем). Подтверждённый пользователь получает часовую bearer-сессию в sessionStorage этой вкладки с привязкой к подписи запуска. Backend сверяет whitelist на каждом запросе и привязывает историю и действия к ID из сессии. При смене переменных окружения Compose пересоздайте сервис `app`.

`make test-miniapp` запускает Chromium с мобильным viewport, backend, worker, PostgreSQL и HTTP-адаптер Filmobot в отдельной сети. Тест подставляет подписанные тестовые данные запуска вместо Telegram SDK, а Filmobot получает локальную выдачу RuTor. Результат проверяется по экрану квитанции, количеству файлов в тестовой watch-папке и записям истории.

## Исполнение графа

`make test-runner` поднимает временный PostgreSQL 15 и HTTP-сервис из соседнего проекта `../kinopoisk_bot`. Другой путь можно указать через `FILMOBOT_DIR` (абсолютный путь в WSL). Compose использует отдельную внутреннюю сеть, временную БД и тестовую watch-папку. В тесте реальные процессы CLI завершаются между шагами. Отдельный worker принудительно останавливается между передачей файла и получением квитанции.

Для собственного запуска worker требуется доступ к PostgreSQL через `DATABASE_URL` и к Filmobot через `FILMOBOT_BASE_URL` и `FILMOBOT_SERVICE_TOKEN`. CLI предназначен для доверенного оператора. Он принимает actor как числовой Telegram ID. В пользовательском API actor должен устанавливаться после авторизации.

Пример команд внутри образа `jarvis-config-dev:local`, в сети с доступом к этим сервисам:

```sh
node src/run.ts migrate
node src/run.ts publish examples/services/filmobot.connection.json examples/workflows/cinema-search.json
node src/run.ts start cinema.search-and-download 42
# RUN — UUID, который вернула команда start.
node src/run.ts act "$RUN" 42 query submit '{"query":"Солярис"}'
node src/run.ts worker
```

Worker оставляют запущенным. В другой консоли `show` возвращает текущий экран и сохранённые варианты. Подставьте значение `value` из фактической выдачи:

```sh
node src/run.ts show "$RUN" 42
node src/run.ts act "$RUN" 42 choose select '{"value":"rutor:12345"}'
node src/run.ts show "$RUN" 42
node src/run.ts history "$RUN" 42
```

Опубликованная ревизия включает граф и контракт. Повторный клик по завершённому шагу возвращает `false`. Конкурирующие worker забирают шаг через PostgreSQL с блокировкой `SKIP LOCKED`. После потери worker шаг снова доступен через 75 секунд. Повтор изменяющей операции требует поддержки идемпотентности сервисом. В журнале сохраняются ключ команды и отдельный ID каждого HTTP-запроса. При неопределённой передаче конечный экран предлагает сверить очередь uTorrent.
