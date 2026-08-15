import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// MO — модалки против плавающей мобильной навигации.
//
// Нижняя навигация — position: fixed с z-index 70 и непрозрачным фоном. Любая
// модалка с меньшим z рисуется ПОД ней: футер с «Отмена»/«Сохранить» накрыт,
// а кнопки навигации остаются кликабельными поверх затемнения — тап по нижней
// части модалки уводит на другую вкладку с потерей несохранённой формы. Так
// было в пяти экранах разом, потому что каждый копировал одну и ту же строку
// оверлея с z-50.
//
// Примитивы components/ui/* (Radix) сюда не входят: они рендерятся порталом и
// имеют собственную дисциплину слоёв.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

async function tsxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await tsxFiles(full)));
    else if (entry.name.endsWith(".tsx")) files.push(full);
  }
  return files;
}

test("MO1 ни одна страничная модалка не живёт ниже нижней навигации", async () => {
  const dirs = [path.join(negisSrc, "pages"), path.join(negisSrc, "components", "admin"), path.join(negisSrc, "components", "layout"), path.join(negisSrc, "components", "crm")];
  for (const dir of dirs) {
    for (const file of await tsxFiles(dir)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/fixed inset-0 z-(\S+)/g)) {
        const z = match[1];
        // Разрешён только слой выше навигации (70): у продукта это z-[80].
        assert.ok(
          /^\[(8|9)\d\]$/.test(z),
          `${path.relative(negisSrc, file)}: оверлей «fixed inset-0 z-${z}» ниже мобильной навигации (z-index 70)`,
        );
      }
    }
  }
});

test("MO2 навигация действительно на слое 70 — иначе MO1 сторожит не то", async () => {
  const css = await readFile(path.join(negisSrc, "index.css"), "utf8");
  const nav = css.slice(css.indexOf(".mobile-bottom-nav {"), css.indexOf(".mobile-bottom-nav {") + 400);
  assert.ok(/z-index:\s*70/.test(nav), "z-index навигации переехал — пересмотрите порог в MO1");
});

test("MO3 модалка справочника исполнителей прокручивается на малых экранах", async () => {
  const editor = await readFile(path.join(negisSrc, "components", "admin", "DoctorSchedule.tsx"), "utf8");
  // Без max-h + overflow карточка на iPhone SE выше экрана, а прокрутить
  // нечем: ни заголовок, ни «Сохранить» не достать.
  assert.ok(/max-h-\[90vh\][^"]*overflow-y-auto[^"]*bg-white/.test(editor), "карточке модалки нужны max-h и overflow-y-auto");
});

test("MO4 поля с инлайновым шрифтом не зумят iOS", async () => {
  const css = await readFile(path.join(negisSrc, "index.css"), "utf8");
  // iOS зумит страницу при фокусе поля с computed font-size < 16px. Классовые
  // поля закрывает правило .neu-input, а инлайновые стили Рекламы и Контента
  // перекрывает только !important внутри мобильного медиа-блока.
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 767px)"));
  assert.ok(
    /\.negis-main input[^{]*\{[^}]*font-size:\s*16px\s*!important/s.test(mobileBlock),
    "мобильное правило 16px !important для инлайновых полей обязано остаться",
  );
});
