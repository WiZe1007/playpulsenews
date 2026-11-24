# Джерела новин Play Pulse

Каталог доповнює чинну базу джерел для пошуку о 10:00 `Europe/Kyiv`. Усі 16 додаткових джерел і тематичних стрічок збережено в наявному хмарному завданні 24.11.2026. Інструкція кожного запуску міститься в [news-monitor-prompt.md](news-monitor-prompt.md), параметри завдання в [news-monitor.json](news-monitor.json).

Відбирай матеріали, що впливають на публікацію Android-застосунків, правила Google Play, монетизацію, ASO та Android-гемблінг. Зберігай рубрики «Політики», «Публікація», «Монетизація», «Ігри», «Магазин», «API», «Гемблінг». Новини про характеристики пристроїв, партнерські пропозиції й реклама до стрічки не входять.

| Джерело | Тема | Роль під час підготовки новини |
|---|---|---|
| [Google Ads: зміни політик](https://support.google.com/adspolicy/topic/29265?hl=en) | Рекламні правила, сертифікація, країни й строки | Офіційне першоджерело Google |
| [Google Advertising and Measurement Developer Blog](https://developers.google.com/ads/blog) | Рекламні API та SDK, мобільна монетизація | Офіційне першоджерело Google; чинна адреса колишнього Ads Developers Blog |
| [Firebase Android SDK Release Notes](https://firebase.google.com/support/release-notes/android) | Зміни SDK, Analytics, Crashlytics, повідомлень | Офіційне першоджерело Google |
| [Firebase Blog](https://firebase.blog/) | Анонси Firebase та зміни інструментів для застосунків | Офіційне першоджерело Google |
| [Android Security Bulletins](https://source.android.com/docs/security/bulletin) | Виправлення безпеки Android | Офіційне першоджерело Android; відбирай зміни, важливі для застосунків |
| [AppTweak](https://www.apptweak.com/en/aso-blog) | ASO, видимість у Google Play, власні дослідження ринку | Першоджерело власної аналітики AppTweak; відокремлюй висновки компанії від політик Google |
| [Android Weekly](https://androidweekly.net/) | Добірки новин та інструментів Android | Пошук тем і додатковий контекст; переходь до першоджерела кожної події |
| [9to5Google: Google Play Store](https://9to5google.com/guides/google-play-store/) | Функції магазину, оновлення й помітні проблеми | Пошук тем і додаткові посилання після перевірки офіційного підтвердження |
| [Android Authority: Google Play Store](https://www.androidauthority.com/tag/google-play-store/) | Зміни Google Play, дослідження застосунків і тести функцій | Пошук тем і додатковий контекст; результати тестів не підтверджують загальний запуск |
| [Kansspelautoriteit, Нідерланди](https://kansspelautoriteit.nl/nieuws) | Гемблінг-реклама, ліцензії, нелегальні застосунки | Офіційне першоджерело регулятора для Нідерландів |
| [UK Gambling Commission](https://www.gamblingcommission.gov.uk/news) | Онлайн-гемблінг, вимоги до операторів, рішення й консультації | Офіційне першоджерело регулятора; зазначай територію дії конкретного документа |
| [Malta Gaming Authority](https://www.mga.org.mt/category/news/) | Правила, ліцензії, неавторизовані сервіси | Офіційне першоджерело регулятора Мальти |
| [SPA, Міністерство фінансів Бразилії](https://www.gov.br/fazenda/pt-br/composicao/orgaos/secretaria-de-premios-e-apostas/apostas-de-quota-fixa/legislacao) | Нормативні акти й технічні роз’яснення щодо ставок | Офіційне першоджерело для Бразилії |
| [Android Developers на YouTube](https://www.youtube.com/@AndroidDevelopers) | Презентації, PolicyBytes, пояснення можливостей Google Play | Пошук тем і додаткові відеопосилання; основним посиланням новини має бути відповідний офіційний матеріал Google |
| [GApps Leaks у Telegram](https://t.me/s/GappsLeaks) | Знахідки в застосунках Google, зображення й тестові функції | Пошук тем і додаткові посилання після офіційного підтвердження; витік або APK teardown сам по собі не є підставою для публікації |
| [Traffnews у Telegram](https://t.me/s/traffnews) | Рекламні платформи, affiliate та iGaming | Перевірені повідомлення для «Гемблінгу» зі статусом «Повідомлення каналу»; рекламні матеріали й партнерські пропозиції пропускай |

Попередня база зберігається: Google Play Blog, Android Developers Blog, оголошення й строки політик Play Console, Google Play Business, сторінка стану Google Play, release notes Play Billing, Play Integrity, Play Age Signals, Play Games і Android developer verification. Для гемблінгу залишаються DIA Нової Зеландії, законодавство Австралії, Конгрес Бразилії та PlayCity України.

Раніше дозволені публічні Telegram-канали: [Traffic Arts](https://t.me/s/trafficarts), [UAFF](https://t.me/s/uaff_media), [Affhub](https://t.me/s/affhubmedia), [iGaming News](https://t.me/s/igaming_news), [PlayCity](https://t.me/s/playcityukr), [Android Broadcast](https://t.me/s/android_broadcast). Для джерел у новинах використовуй прямі посилання на конкретні дописи. Адреси каналів у каталозі призначені для пошуку.

Основне посилання новини про політики або запуск Google Play має вести на офіційний матеріал. Медіа, дайджести, YouTube та GApps Leaks дають теми й контекст; їхні посилання можна додавати після звірки фактів із першоджерелом. AppTweak можна цитувати як автора власного дослідження, зі збереженням його методики та обмежень. Просування сервісів AppTweak до новин не включай.

Для перевірених галузевих повідомлень у «Гемблінгу» зберігай статус «Повідомлення каналу», коли це не офіційний анонс. Звіряй повний текст, автора, дату та конкретні твердження; посилання на інший канал не є незалежним підтвердженням.

Пиши власний виклад українською, лаконічно й професійно. Дату публікації, дату набуття чинності та регіон указуй окремо. Порівнюй нові матеріали з усією живою стрічкою за подією, змістом і канонічними посиланнями. Коли перевірених нових подій немає, нічого не публікуй; щоденної квоти дописів немає.
