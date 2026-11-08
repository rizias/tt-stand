import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { wireSeries } from './overview.mjs';

export function embedJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

async function writeDetail(directory, relative, key, value) {
  const file = path.join(directory, relative);
  await mkdir(path.dirname(file), { recursive: true });
  const text = `globalThis.reportLoad(${embedJson(key)},${embedJson(value)});\n`;
  try {
    await writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw new Error(`Детализация ${relative} не записана: ${error.message}`);
  }
  return Buffer.byteLength(text);
}

export async function writeDetails(directory, model) {
  let bytes = 0,
    files = 0;
  for (const [index, panel] of model.panels.entries()) {
    if (panel.type === 'line') {
      for (const [seriesIndex, item] of panel.series.entries()) {
        bytes += await writeDetail(
          directory,
          `detail/series/${index}/${seriesIndex}.js`,
          `series:${index}:${seriesIndex}`,
          wireSeries(item),
        );
        files += 1;
      }
    }
    if (panel.type === 'table') {
      for (const [blockIndex, block] of panel.blocks.entries()) {
        bytes += await writeDetail(
          directory,
          `detail/tables/${index}-${blockIndex}.js`,
          `table:${index}:${blockIndex}`,
          block,
        );
        files += 1;
      }
    }
  }
  return { detailDirectory: path.join(directory, 'detail'), detailBytes: bytes, detailFileCount: files };
}
