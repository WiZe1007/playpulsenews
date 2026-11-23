# Play Pulse на Cloudflare

Сайт і Telegram-бот використовують один публічний Cloudflare Worker, два внутрішні SQLite-backed Durable Objects та постійну базу D1. Сайт відкривається після входу власника. Бот приймає команди через `/telegram/webhook` і читає ту саму стрічку з D1.

Обчислення пароля виконує внутрішній Durable Object `PlayPulseAuth` через прив’язку `AUTH`. Він приймає лише `POST /api/account/setup`, `POST /api/account/login` і `POST /api/account/password` після перевірок у шлюзі. Публічної адреси для об’єкта немає. Стрічка, обліковий запис, сеанси та стан доставки залишаються в D1. Формат `HMAC-PEPPER-PBKDF2-SHA256-v1` зі 100 000 ітерацій не змінюється; повторне створення кабінету чи перенесення його даних для ввімкнення об’єкта не потрібне.

Telegram обробляє Durable Object `PlayPulseBot` через прив’язку `BOT`. Публічний Worker спочатку перевіряє адресу, метод і секрет webhook, а потім передає запит об’єкту. Плановий обробник викликає його внутрішній `POST /internal/telegram-delivery`, який виконує міст стрічки та доставку. Цей шлях не відкриває публічного маршруту запуску доставки.

Cron щохвилини переносить нові опубліковані записи з поточної приватної стрічки Sites і доставляє сповіщення. За один виклик він обробляє до 10 нових записів джерела й надсилає до трьох частин дайджесту. У документації проєкту зазначено моніторинг о 10:00 `Europe/Kyiv`, але відповідну автоматизацію не знайдено й фактичне виконання не перевірено. Міст підтримує надходження матеріалів, які публікуються в Sites. Нового розкладу пошуку новин він не створює. Коли наявний видавець почне записувати новини безпосередньо в Cloudflare, міст можна вимкнути.

## Доступ і зберігання

У `cloudflare/wrangler.jsonc` слід зберігати `assets.run_worker_first: true`, `html_handling: "none"` і `not_found_handling: "none"`. Застосунок перевіряє доступ перед видачею файлів. Публічні лише сторінка входу, її CSS і JS, логотип, декоративне тло `scene-5.webp`, `/api/runtime` та `/healthz`. `/telegram/webhook` приймає запити з окремим секретом Telegram. Статичний `site/dist/news.json` і каталог збірки `server/` виключено із завантаження assets.

Конфігурація містить дві прив’язки та дві послідовні міграції:

| Прив’язка | Клас | Стабільне ім’я екземпляра | Міграція |
| --- | --- | --- | --- |
| `AUTH` | `PlayPulseAuth` | `play-pulse-owner-auth-v1` | `auth-v1`, `new_sqlite_classes: ["PlayPulseAuth"]` |
| `BOT` | `PlayPulseBot` | `play-pulse-telegram-v1` | `bot-v1`, `new_sqlite_classes: ["PlayPulseBot"]` |

Саме SQLite-backed Durable Objects доступні на Workers Free. Обидва класи залишають дані в D1, не створюють власних SQL-таблиць чи окремого процесу long polling. Якщо потрібна прив’язка недоступна, операція повертає помилку без виконання важкого обробника в головному Worker. [Durable Objects Free](https://developers.cloudflare.com/durable-objects/platform/pricing/).

D1 зберігає JSON-об’єкти в таблиці `objects`:

| Ключ | Дані |
| --- | --- |
| `news/updates-v1.json` | Повна спільна стрічка |
| `account/admin-v1.json` | Новий кабінет власника |
| `account/sessions-v1.json` | Хеші сеансів |
| `account/rate-*.json` | Обмеження спроб входу |
| `telegram/notifications-v1.json` | Стан доставки з ID новин |
| `telegram/update-*-v1.json` | Оброблені Telegram updates |
| `telegram/notification-lease-*-v1.json` | Тимчасові блокування доставки |

Умовні записи порівнюють ETag в одному SQL-запиті. Пошкоджені дані спричиняють помилку; відсутня стрічка не замінюється порожнім архівом. Міст додає лише відсутні ID та зберігає редакції власника навіть за паралельного запису.

## Параметри Worker

Значення зберігаються в Cloudflare Secrets або локальних ігнорованих файлах із правами `0600`.

| Назва | Призначення |
| --- | --- |
| `PLAY_PULSE_PUBLIC_ORIGIN` | Точний HTTPS origin без кінцевого `/` |
| `PLAY_PULSE_OWNER_ID` | Постійний випадковий ідентифікатор нового кабінету |
| `PP_PASSWORD_PEPPER` | Окремий секрет із 64 шістнадцяткових символів |
| `PLAY_PULSE_READ_TOKEN` | Лише `GET` і `HEAD /news.json` |
| `PLAY_PULSE_WRITE_TOKEN` | Лише `POST /api/news` |
| `PLAY_PULSE_SETUP_TOKEN` | Початкове налаштування кабінету |
| `TELEGRAM_BOT_TOKEN` | Наявний токен бота |
| `TELEGRAM_ALLOWED_USER_IDS` | Дозволені числові ID через кому |
| `TELEGRAM_WEBHOOK_SECRET` | Перевірка заголовка `X-Telegram-Bot-Api-Secret-Token` |
| `PLAY_PULSE_NOTIFICATIONS_ENABLED` | `0` до перенесення стану доставки, потім `1` |
| `PLAY_PULSE_UPSTREAM_SITES_TOKEN` | Сервісний доступ лише до поточного канонічного джерела Sites; потрібен тимчасово |

Ключі читання, запису й налаштування мають відрізнятися та містити від 32 до 128 символів base64url. `TELEGRAM_WEBHOOK_SECRET` допускає від 32 до 256 таких символів. Зберігайте ідентифікатор власника й pepper після створення кабінету: їх довільна заміна порушить перевірку наявного пароля.

## Публікація та перенесення

Локально потрібен Node.js 22+. Перші команди виконуються з `cloudflare/`:

```sh
npm install
npm test
npm run build
npx wrangler login
npx wrangler d1 create playpulsenews
```

`npm run build` виконує dry-run без публікації. Підставте отриманий `database_id` у прив’язку `DB`. Застосуйте схему:

```sh
npx wrangler d1 execute playpulsenews --remote --file schema.sql
```

Перед остаточним експортом зупиніть процес бота на Mac і збережіть його стан доставки. Отримайте повну живу стрічку через дозволений сервісний доступ. Початкова вибірка цього перенесення містить 41 запис; перевірте актуальний склад під час експорту. У локальному `site/dist/news.json` лише 12 початкових записів.

Із кореня проєкту підготуйте приватний імпорт:

```sh
node cloudflare/migrate.mjs \
  --news deploy/.private/live-news.json \
  --notifications deploy/.private/notifications.json \
  --out deploy/.private/cloudflare-import.sql
```

Утиліта створює новий SQL-файл із правами `0600` і виводить лише кількість записів та власників. Вона переносить повні новини й стан доставки, зберігаючи його поля. Старий кабінет Sites та його сеанси не імпортуються. Імпорт призначений для нової бази до ввімкнення сповіщень; повторне виконання не перезаписує наявні об’єкти.

Поверніться в `cloudflare/`:

```sh
npx wrangler d1 execute playpulsenews --remote --file ../deploy/.private/cloudflare-import.sql
npx wrangler deploy --secrets-file ../deploy/.private/cloudflare-secrets.json
```

Файл секретів містить параметри у форматі JSON і зберігається лише локально. Під час першого розгортання залиште сповіщення вимкненими. Оновлення секретів окремо від коду також підтримується:

```sh
npx wrangler secret bulk ../deploy/.private/cloudflare-secrets.json
```

Створіть новий кабінет запитом `POST /api/account/setup` із канонічним `Origin`, заголовком `X-Play-Pulse-Setup-Token` і JSON-полями `username`, `password`. Збережіть пароль локально або в менеджері паролів. Перевірте вхід, вихід і заборону читання `/news.json` без сеансу чи ключа.

Після звірки всіх ID та полів стрічки, стану доставки й перевірки кабінету ввімкніть сповіщення. Налаштуйте Telegram `setWebhook` на канонічний `/telegram/webhook`: `secret_token` із Worker Secrets, `max_connections: 1`, `allowed_updates: ["message", "callback_query"]`, `drop_pending_updates: false`. Long polling на Mac має залишатися зупиненим. Перевірте `/start`, `/news`, картку, джерело й архів. Для повернення до long polling спочатку вимикають webhook і зберігають актуальний стан доставки з D1.

## Безкоштовні ліміти й перевірка CPU

Workers Free обмежений 100 000 запитів на добу та 10 мс CPU на звичайний виклик. Приватні файли проходять через Worker і також створюють виклики. D1 Free включає 5 млн прочитаних і 100 000 записаних рядків на добу. Після вичерпання безкоштовних лімітів запити завершуються помилкою. Проєкт не вмикає платний план автоматично. [Ліміти Workers](https://developers.cloudflare.com/workers/platform/limits/), [D1 Free](https://developers.cloudflare.com/d1/platform/pricing/).

Для SQLite-backed Durable Object документація встановлює окремий типовий CPU-бюджет 30 секунд на виклик. Безкоштовний план включає 100 000 запитів до Durable Objects і 13 000 GB-s тривалості на добу. Обчислення пароля, обробка Telegram і планова доставка виконуються в цих компонентах. [Ліміти Durable Objects](https://developers.cloudflare.com/durable-objects/platform/limits/), [безкоштовні квоти](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Після кожної зміни маршрутизації перевіряйте налаштування кабінету, вхід, зміну пароля, webhook і Cron через `wrangler tail` та Cloudflare Metrics/Workers Logs. Порівнюйте окремі події головного Worker, `PlayPulseAuth` і `PlayPulseBot`. Локальні тести та dry-run не замінюють вимірювання CPU на розгорнутому коді. [Вимірювання CPU](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

## Підтверджено під час перенесення

- Робоча адреса: [Play Pulse](https://playpulsenews.play-pulse-cloudflare.workers.dev). В обліковому записі Cloudflare візуально підтверджено Free та вартість $0.
- Повну стрічку з 41 запису звірено з живим джерелом. Вхід, вихід і приватна головна сторінка повернули успішні відповіді; читання стрічки без доступу повернуло `401`.
- Для автентифікації після винесення в `PlayPulseAuth` головний Worker використав від 0 до 7 мс CPU, об’єкт від 27 до 63 мс. Перевірено вхід і зміну пароля; початковий пароль відновлено.
- Ручний виклик перенесення джерела через Cron завершився успішно. Реальну команду власника `/news` оброблено, у D1 підтверджено завершення update, а Telegram повідомив `pending_update_count: 0`.
- Після розгортання `de25a066` планова доставка використала від 0 до 1 мс CPU головного Worker та 14 мс у `PlayPulseBot`. Внутрішній виклик `/internal/telegram-delivery` завершився з `outcome: ok`, без винятків.
- Автентифікований повтор уже обробленої команди власника `/news` повернув `200`: головний Worker використав 3 мс CPU, `PlayPulseBot` 2 мс. Додаткового повідомлення не надіслано.
- Локально пройшли 52 перевірки Cloudflare, 99 перевірок бота, 23 серверні перевірки сайту, 8 перевірок інтерфейсу кабінету, 3 перевірки вставлення без перезапису та скрипти перевірки маршрутів і кабінету Worker.
