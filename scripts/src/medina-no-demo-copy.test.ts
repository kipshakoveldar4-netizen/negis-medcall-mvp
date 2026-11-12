import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// ND — слова «демо» нет в том, что читает пользователь.
//
// Требование владельца: на платформе слова «демо» быть не должно. Требование
// про ЭКРАН, а не про код: `demoStorage`, `DemoCrmModules`, сентинел
// `"demo-workspace"` и поле `mode: "demo"` в ответах — это имена и значения
// протокола, их видит разработчик, а не клиника.
//
// Отличать одно от другого нужно правилом, а не списком. Правило такое:
// пользовательский текст в этом продукте — русский. Значит запрещена строка,
// в которой есть И кириллица, И слово «демо» в любом написании. «Демо-режим»,
// «Demo-пакет контента готов» и «Сейчас demo-режим сохраняет данные» попадают,
// «demo-workspace» и `mode === "demo"` — нет.
//
// Почему проверка отдельная и такая. Прежние две были написаны как
// `!/>\s*Демо-режим\s*</`, то есть совпадали только с текстовым узлом JSX —
// а дефект жил в фигурных скобках: `{isDemoMode ? 'Демо-режим' : …}`. Запрет,
// который не может сработать на том коде, который запрещает, — это не запрет,
// а комментарий с синтаксисом ассерта.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const uiRoot = path.join(repoRoot, "artifacts", "negis", "src");

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry.name)) yield full;
  }
}

/** Исходник без комментариев: в них слово «демо» упоминается нарочно. */
function stripComments(source: string): string {
  return source
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ");
}

/** Строковые литералы и текстовые узлы JSX — всё, что доходит до экрана. */
function userStrings(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(/"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  // Текст между тегами: >…< без фигурных скобок внутри.
  for (const match of code.matchAll(/>([^<>{}]{2,})</g)) found.push(match[1]);
  return found;
}

const HAS_CYRILLIC = /[Ѐ-ӿ]/;
const HAS_DEMO = /демо|demo/i;

test("ND1 ни одна пользовательская строка не содержит слова «демо»", async () => {
  const offenders: string[] = [];

  for await (const file of walk(uiRoot)) {
    const code = stripComments(await readFile(file, "utf8"));
    for (const value of userStrings(code)) {
      if (HAS_CYRILLIC.test(value) && HAS_DEMO.test(value)) {
        offenders.push(`${path.relative(repoRoot, file)}: ${value.trim().slice(0, 80)}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `слово «демо» осталось в пользовательском тексте:\n${offenders.join("\n")}`);
});

test("ND2 сама проверка умеет краснеть", () => {
  // Мутант: та самая форма, в которой дефект и жил — в фигурных скобках,
  // а не текстовым узлом. Прежняя проверка её не видела.
  const mutant = `const label = isDemoMode ? 'Демо-режим' : 'Медицинская CRM';`;
  const strings = userStrings(stripComments(mutant));
  const caught = strings.filter((value) => HAS_CYRILLIC.test(value) && HAS_DEMO.test(value));
  assert.deepEqual(caught, ["Демо-режим"], "мутант обязан попадаться");

  // И обратное: имена и значения протокола проверку не красят.
  const innocent = `const id = "demo-workspace"; if (body.mode === "demo") return; import "@/lib/demoStorage";`;
  const missed = userStrings(stripComments(innocent)).filter(
    (value) => HAS_CYRILLIC.test(value) && HAS_DEMO.test(value),
  );
  assert.deepEqual(missed, [], "идентификаторы и значения протокола не трогаются");
});

test("ND3 подпись режима без базы достижима", async () => {
  // Слово убрано, смысл сохранён, и главное — подпись теперь вообще
  // показывается. Раньше она висела на ветке, до которой выполнение
  // не доходит, то есть проверка закрепляла мёртвый код.
  const sidebar = await readFile(path.join(uiRoot, "components", "layout", "Sidebar.tsx"), "utf8");

  assert.ok(/Пробный доступ/.test(sidebar), "режим без базы подписан");
  assert.ok(/const noClinicSelected = !isRealWorkspace\(\)/.test(sidebar), "по достижимому условию");
  assert.ok(!/isDemoMode \? '/.test(sidebar), "мёртвый флаг больше ничего не решает");
});

test("ND4 тариф клиники не подменяется прайсом", async () => {
  const calculator = await readFile(path.join(uiRoot, "components", "admin", "PlanCalculator.tsx"), "utf8");

  assert.ok(calculator.includes("Тариф не назначен"), "отсутствие подписки названо вслух");
  assert.ok(calculator.includes("Не удалось прочитать тариф"), "отказ чтения — не «тарифа нет»");
});
