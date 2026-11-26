# Джерела новин Play Pulse

Каталог доповнює чинну базу джерел для пошуку о 10:00 `Europe/Kyiv`. 26.11.2026 пріоритет надано міжнародним змінам для Android-видавців. Однодержавні новини про правила магазинів і гемблінг та матеріали про Нідерланди виключено з пошуку. Інструкція кожного запуску міститься в [news-monitor-prompt.md](news-monitor-prompt.md), параметри завдання в [news-monitor.json](news-monitor.json).

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
| [Android Developers на YouTube](https://www.youtube.com/@AndroidDevelopers) | Презентації, PolicyBytes, пояснення можливостей Google Play | Пошук тем і додаткові відеопосилання; основним посиланням новини має бути відповідний офіційний матеріал Google |
| [GApps Leaks у Telegram](https://t.me/s/GappsLeaks) | Знахідки в застосунках Google, зображення й тестові функції | Пошук тем і додаткові посилання після офіційного підтвердження; витік або APK teardown сам по собі не є підставою для публікації |
| [Traffnews у Telegram](https://t.me/s/traffnews) | Рекламні платформи, affiliate та iGaming | Перевірені повідомлення для «Гемблінгу» зі статусом «Повідомлення каналу»; рекламні матеріали й партнерські пропозиції пропускай |
| [Google AdMob](https://developers.google.com/admob/android/next-gen/rel-notes) та [Legacy SDK](https://developers.google.com/admob/android/rel-notes) | Мобільна реклама | Журнал конкретного SDK |
| [Google bundletool](https://github.com/google/bundletool/releases) | Android App Bundle | Опис конкретного релізу Google |
| [RevenueCat Android](https://github.com/RevenueCat/purchases-android/releases) | Покупки та підписки | Реліз власного SDK |
| [Samsung Developer News](https://developer.samsung.com/sdp/news/en) | Дистрибуція в Galaxy Store | Оголошення Samsung |
| [Appfigures Insights](https://appfigures.com/resources/insights) | Показники ринку Android | Власні оцінки з указаним періодом |
| [Єврокомісія, DMA](https://digital-markets-act.ec.europa.eu/latest-news_en) | Правила ринку ЄС | Офіційні матеріали із точним статусом справи |
| [AndroidDevEU](https://t.me/s/AndroidDevEU) | Новини спільноти | Пошук тем і конкретні дописи як додаткові джерела |
| [Android Developer Podcasts](https://developer.android.com/podcasts) | Випуски Now in Android і Backstage | Пошук тем, офіційні матеріали й відео випусків |
| [App2App](https://t.me/s/app2rb) | Рекламні мережі й аналітика мобільних застосунків | Пошук тем, перевірка за повідомленням платформи |
| [Gambla4](https://t.me/s/gamblnews) | Європейські й міжнародні рішення щодо реклами онлайн-гемблінгу | Пошук тем із конкретним впливом на Android-видавців |
| [Гемблинг / iGaming (Партнеркин)](https://t.me/s/thepartnerkin_gambl) | Галузеві дайджести | Перейти до автора дослідження чи рішення |
| [CPA.RIP](https://t.me/s/cparip) | Мобільна реклама та рекламне шахрайство на Android | Перевірити первинний звіт або анонс платформи |
| [StartAndroid](https://t.me/s/startandroid) | Android Studio, Gradle, інструменти розробника | Перевірити дату і суттєві зміни в офіційних нотатках до релізу |

Попередня база зберігається: Google Play Blog, Android Developers Blog, оголошення й строки політик Play Console, Google Play Business, сторінка стану Google Play, release notes Play Billing, Play Integrity, Play Age Signals, Play Games і Android developer verification. Національні регулятори доступні як джерела історичних матеріалів; нові локальні рішення пропускай.

Раніше дозволені публічні Telegram-канали: [Traffic Arts](https://t.me/s/trafficarts), [UAFF](https://t.me/s/uaff_media), [Affhub](https://t.me/s/affhubmedia), [iGaming News](https://t.me/s/igaming_news), [PlayCity](https://t.me/s/playcityukr), [Android Broadcast](https://t.me/s/android_broadcast). Для джерел у новинах використовуй прямі посилання на конкретні дописи. Адреси каналів у каталозі призначені для пошуку.

Основне посилання новини про політики або запуск Google Play має вести на офіційний матеріал. Медіа, дайджести, YouTube та GApps Leaks дають теми й контекст; їхні посилання можна додавати після звірки фактів із першоджерелом. AppTweak можна цитувати як автора власного дослідження, зі збереженням його методики та обмежень. Просування сервісів AppTweak до новин не включай.

Для перевірених галузевих повідомлень у «Гемблінгу» зберігай статус «Повідомлення каналу», коли це не офіційний анонс. Звіряй повний текст, автора, дату та конкретні твердження; посилання на інший канал не є незалежним підтвердженням.

Пиши власний виклад українською, лаконічно й професійно. Дату публікації, дату набуття чинності та регіон указуй окремо. Порівнюй нові матеріали з усією живою стрічкою за подією, змістом і канонічними посиланнями. Коли перевірених нових подій немає, нічого не публікуй; щоденної квоти дописів немає.
