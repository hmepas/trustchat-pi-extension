# TrustChat provider for pi

Порт плагина `@trustchat/opencode-provider@0.3.2` (OpenCode V2) на extension API
pi coding agent. Расположение — глобальное (`~/.pi/agent/extensions/trustchat/`),
загружается автоматически, hot-reload через `/reload`.

## Что делает

- Регистрирует провайдер **trustchat** (OpenAI-совместимый, `api: openai-completions`)
  с `baseUrl https://trustchat.wb-bank.ru:8443/v1`.
- Фабрика расширения не ходит в сеть: провайдер регистрируется сразу
  (пустой список), запуск pi не задерживается.
- Список моделей — из `GET /v1/models` внутри `refreshModels` (pi вызывает его
  в фоне при интерактивном старте, после `/login` и в `--mode rpc`). Запрос к
  `/models` и загрузка каталога идут параллельно; таймаут `/models` 15 с,
  каталога 5 с.
- Последний успешный список сохраняется в хранилище pi
  (`~/.pi/agent/models-store.json`) и при следующем запуске виден сразу, без
  сети, в т.ч. в `pi --list-models` и при `--offline` / `PI_OFFLINE=1`.
  `pi --list-models` сам в сеть не ходит: на чистой установке список появится
  после первого интерактивного запуска (или `/login`). `pi update --models`
  провайдеры расширений не обновляет.
- Ошибка сети, не-2xx или ответ `/models` неизвестного формата (например,
  `{"error": ...}`) не стирают список: pi оставляет предыдущий. Пустой массив
  (`{"data": []}`) — валидный пустой список.
- Метаданные (имена, лимиты, reasoning, image-input) — из каталога models.dev;
  кэш: `~/Library/Caches/pi/trustchat/models.json` (macOS).
  Без каталога: имя = id, контекст 128K, вывод 16K.
- Alias-правила и суффиксы имён перенесены 1:1 из плагина:
  `glm-5.3-flashx` → `glm-5.3-flash`, `kimi-for-coding` → `kimi-k3.1-pro`,
  `k3*` → `kimi-k3*`, `-highspeed`, `-256k`, лестница минимальных суффиксов.
- TrustChat ждёт `max_tokens`, а не `max_completion_tokens`. Pi отправляет
  инструкции с ролью `system`: GLM Flash отклоняет роль `developer`.
- Модели без матча в каталоге (при доступном каталоге) пропускаются — аналог
  «выключена по умолчанию» в opencode-плагине (у pi нет флага disabled).
- Cost везде 0: биллинг TrustChat не совпадает с models.dev.

## Авторизация

`/login` → **TrustChat** → Enter API key, либо переменная окружения
`TRUSTCHAT_API_KEY`. Ключ разрешает сам pi; расширение получает его только в
`refreshModels` и без ключа в сеть не ходит.

## Переменные окружения (все необязательные)

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `TRUSTCHAT_BASE_URL` | `https://trustchat.wb-bank.ru:8443/v1` | Базовый URL API |
| `TRUSTCHAT_MODELS_DEV_URL` | `https://models.dev/models.json` | URL каталога |
| `TRUSTCHAT_MODELS_DEV_DISABLED` | — | `1`/`true`: без каталога, только дефолты |
| `TRUSTCHAT_MODELS_DEV_CACHE` | путь по ОС | Абсолютный путь к файлу кэша каталога |
| `TRUSTCHAT_DEBUG` | — | `1`/`true`: диагностика в stderr |

## Использование

```bash
pi --provider trustchat --model corp-key144/glm-5.3
pi --list-models trustchat     # проверка списка
```

## Диагностика

По умолчанию расширение ничего не пишет в консоль (иначе текст попадает в
TUI). С `TRUSTCHAT_DEBUG=1` сообщения с префиксом `[trustchat]` (матчи каталога,
пропущенные модели, итог обновления) идут в stderr; ключ и тела ответов не
логируются. Ошибки обновления списка показывает сам pi.

## Структура и тесты

- `index.ts` — регистрация провайдера и `refreshModels`;
- `gateway-models.ts` — разбор `/models`, лестница суффиксов, сборка моделей;
- `models-dev.ts` — каталог models.dev (основан на коде плагина, переработан).

```bash
npm test    # node --test, без сети
```
