# Play Pulse на Render

Репозиторій містить приватний сайт і Telegram-бота. На Render це два окремі сервіси Node.js 22 у Frankfurt: Web Service для сайту та Background Worker для бота. Кожен має один постійний диск розміром 1 ГБ, змонтований у `/var/data`, та один екземпляр процесу.

`render.yaml` описує конфігурацію. Перший перенос виконується через Dashboard: перед запуском потрібно додати приватні JSON-файли й секрети. Їхній вміст не входить до Git.

## Сайт

- Root Directory: `site`.
- Build Command: `npm ci --omit=dev`.
- Start Command: `node server/start.mjs`.
- Health Check Path: `/healthz`.
- Node.js: `NODE_VERSION=22`.
- Постійні дані: `PLAY_PULSE_DATA_DIR=/var/data/play-pulse`.
- Початкова жива стрічка: Secret File `play-pulse-news.json`; `PLAY_PULSE_SEED_FILE=/etc/secrets/play-pulse-news.json`.

Використовується повний експорт живого сайту. Статичний `site/dist/news.json` не є резервною копією актуальної стрічки та не підставляється, якщо імпорт відсутній.

Origin береться з `RENDER_EXTERNAL_URL`; за потреби його можна явно вказати в `PLAY_PULSE_PUBLIC_ORIGIN`. Сервер не довіряє заголовкам Host, forwarded або переданій клієнтом ідентичності власника.

Приватні змінні:

- `PLAY_PULSE_OWNER_ID`: стабільний ідентифікатор власника на новому сервері.
- `PP_PASSWORD_PEPPER`: окремий секрет кабінету, 64 шістнадцяткових символи.
- `PLAY_PULSE_READ_TOKEN`: ключ лише для GET/HEAD `/news.json`.
- `PLAY_PULSE_WRITE_TOKEN`: інший ключ для POST `/api/news`.
- `PLAY_PULSE_SETUP_TOKEN`: окремий ключ початкової реєстрації власника.

Ключі не повинні збігатися. Сервісний ключ читання не відкриває кабінет, інші сторінки чи запис новин.

Початковий кабінет створюється один раз через `/api/account/setup` з заголовком `X-Play-Pulse-Setup-Token`, правильним Origin і локально підготовленими даними входу. Публічної реєстрації немає. Старі сесії ChatGPT Sites не переносяться на інший домен; новий кабінет використовує окремі дані входу. Пароль не додається до інструкцій або репозиторію.

## Існуючий моніторинг

Міст міграції дозволяє зберегти поточний моніторинг джерел без другого пошуку новин чи нового розкладу. За наявності `PLAY_PULSE_UPSTREAM_SITES_TOKEN` сервер щохвилини читає лише канонічний старий `/news.json` і додає відсутні ID до Render. Наявні записи та правки власника не перезаписуються.

Помилка старого джерела не видаляє дані нового сайту. Токен Sites надсилається лише старому канонічному хосту. Новий бот читає лише новий Render `/news.json` через окремий bearer-ключ. Сам сайт, кабінет, сховище та бот працюють на Render; старий хост залишається джерелом публікацій існуючого моніторингу, доки його окремо не переведено на новий writer API.

## Бот

- Root Directory: `bot`.
- Build Command: `npm ci --omit=dev`.
- Start Command: `node bot.mjs`.
- `NODE_VERSION=22`.
- `PLAY_PULSE_FEED_URL=https://<новий-сайт>.onrender.com/news.json`.
- `PLAY_PULSE_AUTH_MODE=bearer`.
- `PLAY_PULSE_FEED_TOKEN`: той самий новий ключ, що й `PLAY_PULSE_READ_TOKEN` сайту.
- `TELEGRAM_BOT_TOKEN`: існуючий токен бота.
- `TELEGRAM_ALLOWED_USER_IDS`: підтверджений список власників.
- `PLAY_PULSE_NOTIFICATIONS_ENABLED=1`.
- `PLAY_PULSE_NOTIFICATIONS_INTERVAL_SECONDS=60`.
- `PLAY_PULSE_NOTIFICATIONS_STATE_FILE=/var/data/play-pulse/notifications.json`.

Перед першим хмарним запуском зупиніть локальний launchd-екземпляр. Збережіть актуальний `bot/.runtime/notifications.json` як Secret File `play-pulse-delivery.json` і задайте `PLAY_PULSE_NOTIFICATIONS_BOOTSTRAP_FILE=/etc/secrets/play-pulse-delivery.json`.

Імпорт виконується до Telegram polling, лише якщо постійного checkpoint ще немає. Наявний стан не перезаписується. Переносяться ID й службові відмітки; lock-каталоги, логи та `.env` переносити в репозиторій не потрібно. Одночасний локальний і хмарний polling заборонений.

## Перевірка перенесення

1. Без авторизації сайт відкриває лише сторінку входу та її оформлення; `/news.json`, дані й адміністративні маршрути закриті.
2. Ключ читання повертає всі ID й поля експортованої живої стрічки. Запис, кабінет та інші маршрути з цим ключем недоступні.
3. Власник може увійти в кабінет, працювати з новинами й вийти. Після виходу приватні маршрути знову закриті.
4. Бот читає новий URL, відновив checkpoint і не розсилає архів заново.
5. Обидва сервіси мають статус Live, а локальний бот зупинений. Робота більше не залежить від сну Mac.

Локальні перевірки перед пушем:

```sh
npm --prefix bot test
npm --prefix site test
node site/worker/test-account-ui.mjs
node site/worker/test-insert-only.mjs
```

Рекомендована базова конфігурація коштує $7 на місяць за кожен процес і $0.25 за кожен диск 1 ГБ: разом $14.50 на місяць без додаткового використання. Остаточну суму перевіряйте в Dashboard перед створенням сервісів.
