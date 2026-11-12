import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Иконки приложения из того же логотипа, что и favicon.
//
// Манифест ссылался на один SVG. Android его принимает, а iOS для иконки на
// экране «Домой» — нет: apple-touch-icon обязан быть PNG, иначе система рисует
// уменьшенный снимок страницы. То есть «установить на айфон» работало, но
// иконка получалась не логотипом, а скриншотом.
//
// Библиотек для растеризации в репозитории нет, ставить их ради четырёх
// картинок незачем: логотип — прямоугольник со скруглением и один многоугольник,
// координаты которого прямо в favicon.svg. Здесь он рисуется по этим же
// координатам со сглаживанием четырёхкратной выборкой, а PNG собирается на
// встроенном zlib.
//
// Это скрипт СБОРКИ, а не рантайма: он запускается руками, когда меняется
// логотип, и кладёт результат в public. Никакой сети, никакого production.

const TEAL = [0x0f, 0x76, 0x6e] as const;
const WHITE = [0xff, 0xff, 0xff] as const;

/** Монограмма «M» из favicon.svg, в системе координат 64×64. */
const MONOGRAM: Array<[number, number]> = [
  [15, 47], [15, 17], [21.5, 17], [32, 32.5], [42.5, 17], [49, 17],
  [49, 47], [43, 47], [43, 27.5], [34, 40.5], [30, 40.5], [21, 27.5], [21, 47],
];

const CORNER_RADIUS = 14;

function insideRoundedSquare(x: number, y: number, size: number, radius: number): boolean {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insidePolygon(x: number, y: number, polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // бит на канал
  header[9] = 6; // RGBA
  // Остальные три байта — сжатие, фильтр, чересстрочность: нули.

  // Каждая строка предваряется байтом фильтра. Фильтр 0 — «без фильтра»:
  // картинка маленькая, а простой код здесь дороже пары килобайт.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Рисует иконку.
 *
 * `inset` — доля поля, оставленная пустой по краям. Для maskable-иконки Android
 * обрезает края под форму устройства, и логотип, нарисованный от края до края,
 * теряет углы: безопасная зона у них — центральные 80%.
 */
function drawIcon(size: number, inset: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 4;
  const logo = size * (1 - inset * 2);
  const offset = size * inset;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let teal = 0;
      let white = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = ((x + (sx + 0.5) / samples - offset) / logo) * 64;
          const py = ((y + (sy + 0.5) / samples - offset) / logo) * 64;
          if (!insideRoundedSquare(px, py, 64, CORNER_RADIUS)) continue;
          teal += 1;
          if (insidePolygon(px, py, MONOGRAM)) white += 1;
        }
      }

      const total = samples * samples;
      const index = (y * size + x) * 4;
      if (teal === 0) continue;

      // Доля белого внутри залитой части — это и есть сглаживание монограммы.
      const share = white / teal;
      for (let channel = 0; channel < 3; channel += 1) {
        rgba[index + channel] = Math.round(TEAL[channel] * (1 - share) + WHITE[channel] * share);
      }
      rgba[index + 3] = Math.round((teal / total) * 255);
    }
  }

  return encodePng(size, size, rgba);
}

const publicDir = path.resolve(process.cwd().endsWith("scripts") ? ".." : ".", "artifacts", "negis", "public");
mkdirSync(publicDir, { recursive: true });

const icons: Array<{ file: string; size: number; inset: number }> = [
  { file: "icon-192.png", size: 192, inset: 0 },
  { file: "icon-512.png", size: 512, inset: 0 },
  // Maskable: логотип в центральных 80%, чтобы обрезка углов его не съела.
  { file: "icon-maskable-512.png", size: 512, inset: 0.1 },
  // iOS не принимает SVG для иконки на экране «Домой».
  { file: "apple-touch-icon.png", size: 180, inset: 0 },
];

for (const icon of icons) {
  const png = drawIcon(icon.size, icon.inset);
  writeFileSync(path.join(publicDir, icon.file), png);
  process.stdout.write(`${icon.file}: ${icon.size}×${icon.size}, ${png.length} байт\n`);
}
