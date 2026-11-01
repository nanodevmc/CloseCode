# PROJECT_STATE: CloseCode (Fork nanodevmc/CloseCode)

## 1. Стек и архитектура
- **Runtime & Desktop:** Electron, TypeScript, Vite (electron-vite).
- **Frontend:** React 19, Liquid Glass + Material Design 3, xterm.js.
- **LLM Engine:** SSE stream parsers (OpenAI, Anthropic, DeepSeek, Google Gemini, Groq, Mistral, xAI).
- **Upstream:** `TulenTulenivich/CloseCode:main`
- **Fork:** `nanodevmc/CloseCode` (ветка `main` с AgyUnlocker, Google Pro/Ultra, Remote Control, Portable v0.2.0).
- **Upstream PRs:** PR #2 открыт (https://github.com/TulenTulenivich/CloseCode/pull/2 — 50 багфиксов, 29 файлов, +443/-111).

## 2. Что реализовано
- **50 багфиксов:** ENOENT в инструментах, рекурсивный глоббинг `**`, WHATWG SSE пробелы, склейка сообщений Anthropic, стриминг `reasoning_content`, атомарные сохранения настроек/сессий.
- **Интеграция DeepSeek:** `deepseek-chat` и `deepseek-reasoner` (R1), защита от ошибки 400 по `reasoning_effort`.
- **Google Аккаунт (Gemini Pro/Ultra):** бесшовный импорт OAuth сессии из Antigravity (`~/.gemini/`) без ввода API-ключей.
- **Контекстное окно 1 000 000 токенов (1M):** лимит 1 048 576 токенов и буфер компактификации до 1.5 млн символов.
- **Авто-ротация аккаунтов при 0% лимита (429) с авто-продолжением:** моментальное переключение на следующий доступный аккаунт и продолжение выполнения без прерывания диалога.
- **Обход блокировок AgyUnlocker:** авто-маршрутизация через локальную службу `127.0.0.1:53129` и горячая клавиша **Ctrl+U**.
- **Antigravity Remote Control:** фоновый демон на порту 4242 (`--remote-control`), мобильный веб-пульт и REST/SSE API.
- **CI/CD Релизы под Windows:** workflow `.github/workflows/release.yml` для сборки Portable `.exe` и публикации в GitHub Releases.

## 3. Проверка правил GitHub
- Сборка на `windows-latest` укладывается в нормальные лимиты (2–3 мин), без майнинга и abuse.
- В коде и workflow отсутствуют секреты (используется ephemeral `secrets.GITHUB_TOKEN`).
- Лицензия MIT и авторские права соблюдены.

## 4. Сборка и верификация
- `npm run typecheck` — 0 ошибок.
- `npm run test:agent` — 9/9 тестов пройдено.
- `npm run build` — чистая сборка frontend и backend.
