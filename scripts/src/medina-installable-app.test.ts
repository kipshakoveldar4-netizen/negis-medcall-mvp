import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// IA — приложение ставится на телефон по иконке и обновляется само.
//
// Требование владельца было ровно такое: заходить через иконку и получать
// обновления. Магазины для этого не нужны — нужен манифест с настоящими
// иконками и service worker.
//
// Главное ограничение здесь не про удобство. Ответы /api/ работник не трогает
// НИКОГДА: здесь медицинская CRM, и ответ с карточкой пациента, осевший в кэше
// на телефоне, переживёт и выход из аккаунта, и передачу телефона другому
// человеку. Тот же принцип уже действует в браузерном кэше приложения — он
// живёт только в памяти вкладки.
//
// Ничего здесь не выходит в сеть: проверяются файлы сборки и исходники.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const negis = path.join(repoRoot, "artifacts", "negis");
const publicDir = path.join(negis, "public");

/** Ширина и высота PNG из заголовка IHDR — без библиотек. */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const buffer = await readFile(file);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    assert.equal(buffer[i], signature[i], `${path.basename(file)}: это не PNG`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("IA1 иконки существуют и это настоящие PNG нужных размеров", async () => {
  // iOS не принимает SVG для иконки на экране «Домой»: без PNG система рисует
  // уменьшенный снимок страницы вместо логотипа.
  const expected: Array<[string, number]> = [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
    ["apple-touch-icon.png", 180],
  ];

  for (const [file, size] of expected) {
    const dimensions = await pngSize(path.join(publicDir, file));
    assert.deepEqual(dimensions, { width: size, height: size }, file);
  }
});

test("IA2 манифест описывает устанавливаемое приложение", async () => {
  const manifest = JSON.parse(await readFile(path.join(publicDir, "manifest.webmanifest"), "utf8")) as {
    display?: string;
    start_url?: string;
    icons?: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  };

  assert.equal(manifest.display, "standalone", "своё окно, без адресной строки");
  assert.ok(manifest.start_url, "точка входа задана");

  const png = (manifest.icons || []).filter((icon) => icon.type === "image/png");
  assert.ok(
    png.some((icon) => icon.sizes === "192x192"),
    "192 — минимум, который Android требует для установки",
  );
  assert.ok(png.some((icon) => icon.sizes === "512x512"), "512 — экран запуска");
  assert.ok(
    png.some((icon) => (icon.purpose || "").includes("maskable")),
    "maskable: Android обрезает иконку под форму устройства, и логотип от края до края теряет углы",
  );
});

test("IA3 iOS получает свою иконку", async () => {
  const html = await readFile(path.join(negis, "index.html"), "utf8");

  assert.ok(/rel="apple-touch-icon"[^>]*\.png/.test(html), "apple-touch-icon обязан быть PNG");
  assert.ok(/apple-mobile-web-app-capable/.test(html), "запуск своим окном");
});

test("IA4 работник НИКОГДА не кэширует ответы API", async () => {
  const sw = await readFile(path.join(publicDir, "sw.js"), "utf8");

  // Это ограничение важнее любого удобства: карточка пациента, осевшая в кэше
  // телефона, переживает выход из аккаунта.
  assert.ok(/pathname\.startsWith\("\/api\/"\)/.test(sw), "путь /api/ исключён явно");
  assert.ok(/isNeverCached\(url\)\) return;/.test(sw), "и исключение применяется до любой обработки");

  // Ни одна ветка не должна класть в кэш ответ, не прошедший это условие.
  const putCalls = sw.match(/cache\.put\(/g) || [];
  assert.ok(putCalls.length > 0, "оболочка всё-таки кэшируется");
  const immutableIndex = sw.indexOf("isImmutableAsset(url)");
  const neverIndex = sw.indexOf("isNeverCached(url)");
  assert.ok(neverIndex > 0 && neverIndex < immutableIndex, "проверка запрета стоит раньше кэширования");
});

test("IA5 обновление вообще возможно: отпечаток сборки подставляется", async () => {
  const sw = await readFile(path.join(publicDir, "sw.js"), "utf8");
  const config = await readFile(path.join(negis, "vite.config.ts"), "utf8");

  // Браузер решает, что вышла новая версия, по одному признаку: файл sw.js стал
  // другим. С постоянной строкой деплой проходит незамеченным, и установленное
  // приложение продолжает открывать старую сборку.
  assert.ok(sw.includes("__BUILD_ID__"), "в исходнике стоит место под отпечаток");
  assert.ok(/stampServiceWorker/.test(config), "плагин сборки его проставляет");
  assert.ok(/replace\("__BUILD_ID__", buildId\)/.test(config), "именно заменой");
  assert.ok(
    /createHash\("sha256"\)\.update\(assets/.test(config),
    "отпечаток от имён собранных файлов, а не от времени: сборка без изменений не должна давать лишнего обновления",
  );
});

test("IA6 новая версия не применяется молча", async () => {
  const prompt = await readFile(path.join(negis, "src", "components", "layout", "UpdatePrompt.tsx"), "utf8");
  const app = await readFile(path.join(negis, "src", "App.tsx"), "utf8");
  const sw = await readFile(path.join(publicDir, "sw.js"), "utf8");

  assert.ok(app.includes("<UpdatePrompt />"), "плашка подключена");
  assert.ok(prompt.includes("Вышла новая версия"), "и сообщает о версии словами");

  // Перезагрузка посреди заполнения карточки стирает несохранённое, поэтому
  // переключение происходит по нажатию человека.
  assert.ok(/onClick=\{\(\) => waiting\.postMessage\("skip-waiting"\)\}/.test(prompt), "переключает кнопка");
  assert.ok(/event\.data === "skip-waiting"/.test(sw), "и работник ждёт именно этого сообщения");
  assert.ok(!/self\.skipWaiting\(\);\s*\n\s*\}\);\s*\n\s*self\.addEventListener\("install"/.test(sw), "не переключается сам при установке");
});

test("IA7 приложение не ломается там, где работника быть не может", async () => {
  const prompt = await readFile(path.join(negis, "src", "components", "layout", "UpdatePrompt.tsx"), "utf8");

  // На http без localhost браузер не регистрирует работника вовсе. Это
  // ограничение браузера, и падать из-за него приложение не должно.
  assert.ok(/if \(!\("serviceWorker" in navigator\)\) return;/.test(prompt));
  assert.ok(/if \(!window\.isSecureContext\) return;/.test(prompt));
  assert.ok(/catch \{/.test(prompt), "отказ регистрации не роняет экран");
});
