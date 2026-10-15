# Localized file-matching instruction screens

Created with the built-in image generation tool. English uses the approved find-file screen with the forwarding note. Hebrew, Russian and Arabic use that exact approved English image as the localization reference. The heading explains how to find an existing Telegram file; tags appear only in the procedural instructions. Step 3 includes forwarding to Saved Messages or a private group if replies are unavailable.

Assets: `instructions-{en,he,ru,ar}.{png,mp4}` in this directory.

## Playback

Three-hour static 1920x1080 H.264 (yuv420p) videos at 1 fps with silent stereo AAC and fast-start metadata. Static-file middleware supports byte ranges. No runtime FFmpeg dependency.

The tag action selects the authenticated account's addon language (en, he, ru, ar). Missing or unknown languages fall back to English. Hebrew and Arabic use right-to-left layouts. Recent tags remain deduplicated for five minutes; failed sends return HTTP 503 rather than showing success.

## Rebuild

Requires local FFmpeg. From the repository root:

```sh
scripts/build-tag-instructions.sh          # all languages
scripts/build-tag-instructions.sh he ru ar # selected languages
```

## Final localization prompts

### he

Use case: text-localization. Translate the attached approved English StreamGram TV instruction screen to Hebrew. Preserve the exact layout, logo/English STREAMGRAM wordmark, navy background and cyan/violet glow, small logo and modest heading, two intro lines, four numbered instruction rows. Preserve airy TV-readable typography. Tags are only a procedural detail, NOT the headline. Include the small muted helper note beneath step 3, mentioning BOTH Saved Messages and the user's private group. Correct RTL shaping throughout, mirror rows with number circles on RIGHT and right-aligned text. Center headline and introduction. Numbers 1 2 3 4. Exact text below, in order: headline, two intro lines, step1 title/subtitle, step2 title/subtitle, step3 title/subtitle/two-line smaller helper note, step4 title/subtitle:
"בואו נעזור לתוסף למצוא את הקובץ"
"הקובץ אצלכם בטלגרם, אבל התוסף לא מוצא אותו?"
"כך אפשר לשייך אותו לסרט או לפרק הנכון."
"העתקת ההודעה ששלחנו"
"יש לפתוח את ההודעות השמורות בטלגרם ולהעתיק את התג."
"מציאת הסרט או הפרק"
"יש לאתר את קובץ המדיה בטלגרם."
"תגובה לקובץ"
"יש להשיב לקובץ המדיה ולהדביק את התג."
"אי אפשר להגיב בקבוצה? העבירו את הקובץ להודעות שמורות"
"או לקבוצה פרטית שלכם, ואז השיבו לקובץ עם התג."
"חיפוש חוזר בסטרימיו"
"הקובץ יופיע ראשון בתוצאות."
Keep note visually secondary at about 70% body font, readable. Fit everything within safe margins without crowding or overlap; modestly reduce font if needed. Do not omit text or add elements. Landscape 16:9.

### ru

Use case: text-localization. Translate the attached approved English StreamGram TV instruction screen to Russian. Preserve the exact layout, logo/English STREAMGRAM wordmark, navy background and cyan/violet glow, small logo and modest heading, two intro lines, four numbered instruction rows. Preserve airy TV-readable typography. Tags are only a procedural detail, NOT the headline. Include the small muted helper note beneath step 3, mentioning BOTH Saved Messages and the user's private group. Left-aligned rows with number circles on LEFT. Numbers 1 2 3 4. Exact text below, in order: headline, two intro lines, step1 title/subtitle, step2 title/subtitle, step3 title/subtitle/two-line smaller helper note, step4 title/subtitle:
"Помогите StreamGram найти файл"
"Файл есть в Telegram, но StreamGram его не находит?"
"Свяжите его с нужным фильмом или серией по инструкции ниже."
"Скопируйте наше сообщение"
"Откройте «Избранное» в Telegram и скопируйте тег."
"Найдите фильм или серию"
"Найдите нужный медиафайл в Telegram."
"Ответьте на файл"
"Ответьте на медиафайл и вставьте тег."
"Нельзя ответить в группе? Перешлите файл в «Избранное»"
"или в свою приватную группу и ответьте на него тегом."
"Повторите поиск в Stremio"
"Ваш файл появится первым в результатах."
Keep note visually secondary at about 70% body font, readable. Fit everything within safe margins without crowding or overlap; modestly reduce font if needed. Do not omit text or add elements. Landscape 16:9.

### ar

Use case: text-localization. Translate the attached approved English StreamGram TV instruction screen to Arabic. Preserve the exact layout, logo/English STREAMGRAM wordmark, navy background and cyan/violet glow, small logo and modest heading, two intro lines, four numbered instruction rows. Preserve airy TV-readable typography. Tags are only a procedural detail, NOT the headline. Include the small muted helper note beneath step 3, mentioning BOTH Saved Messages and the user's private group. Correct RTL shaping throughout, mirror rows with number circles on RIGHT and right-aligned text. Center headline and introduction. Numbers 1 2 3 4. Exact text below, in order: headline, two intro lines, step1 title/subtitle, step2 title/subtitle, step3 title/subtitle/two-line smaller helper note, step4 title/subtitle:
"ساعد StreamGram في العثور على ملفك"
"الملف موجود في تيليجرام، لكن الإضافة لا تجده؟"
"اتبع هذه الخطوات لربطه بالفيلم أو الحلقة الصحيحة."
"انسخ الرسالة التي أرسلناها"
"افتح الرسائل المحفوظة في تيليجرام وانسخ الوسم."
"ابحث عن الفيلم أو الحلقة"
"اعثر على ملف الوسائط في تيليجرام."
"رد على الملف"
"رد على ملف الوسائط والصق الوسم."
"لا يمكنك الرد في المجموعة؟ أعد توجيه الملف إلى الرسائل المحفوظة"
"أو إلى مجموعتك الخاصة، ثم رد عليه بالوسم."
"ابحث مجدداً في ستريميو"
"سيظهر ملفك أولاً في النتائج."
Keep note visually secondary at about 70% body font, readable. Fit everything within safe margins without crowding or overlap; modestly reduce font if needed. Do not omit text or add elements. Landscape 16:9.

The approved English source is instructions-en.png. Its edit prompt is saved in generation-en.md alongside the assets.

Check playback in target Stremio clients before deploying broadly.
