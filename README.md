# Jarvis

Jarvis — личный помощник в Telegram. Mini App показывает пользователю формы, варианты выбора и результаты. Workflow связывает эти экраны с операциями сервисов, которые уже работают в Docker на Windows-сервере.

## Первый сценарий

Пользователь вводит название фильма, выбирает раздачу и получает подтверждение передачи файла в watch-папку uTorrent. Тот же Filmobot продолжает принимать команды в своём Telegram-чате. Здесь зафиксирован проект реализации. Примеры описывают целевой API и формат Jarvis v1.

| Что посмотреть | Файл |
|---|---|
| Архитектурное решение, подключение сервиса, контракт вызова | [Спецификация](docs/superpowers/specs/2026-11-22-service-contract.md) |
| Как указать адрес сервиса, credential и доступные операции | [Подключение Filmobot](examples/services/filmobot.connection.json) |
| Параметры поиска, выбор раздачи и ответ о передаче файла | [OpenAPI Filmobot](examples/services/filmobot.openapi.json) |
| Полный граф от поля поиска до результата | [Workflow «Найти и скачать фильм»](examples/workflows/cinema-search.json) |
| Очерёдность работ, зависимости и критерии приёмки | [План реализации](docs/superpowers/plans/2026-11-22-jarvis.md) |

## Проверить сценарий локально

В проекте Filmobot реализованы оба метода контракта. Его Telegram-бот и HTTP-адаптер используют одну логику поиска и передачи раздачи с сохранением квитанций. Для включения API задаются `FILMOBOT_SERVICE_TOKEN` и `JARVIS_ALLOWED_USER_IDS` в окружении Filmobot. Исполнение графа из Mini App запланировано на этапы 3 и 4.

Первый реализованный компонент — TypeScript CLI. Из корня проекта в WSL с доступным Docker:

```sh
make validate
make test
```

`make validate` читает подключение, OpenAPI Filmobot и граф кино. Успешный результат содержит две доступные операции и 11 проверенных узлов. Для своих файлов передай пути внутри проекта: `make validate CONNECTION=examples/services/filmobot.connection.json WORKFLOW=examples/workflows/cinema-search.json`. Файлы открываются только для чтения. Секреты, запущенный Filmobot и доступ к Telegram для этой команды не требуются. `make test` проверяет строгие типы TypeScript и запускает тесты в контейнере.
