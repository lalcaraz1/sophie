import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import * as cheerio from 'cheerio';
import type { Session } from './session.js';
import { fixMojibake, sanitize } from './util.js';

// Rutas ya escritas en la corrida actual. Sirve para no pisar dos recursos
// distintos que caen en el mismo nombre dentro de una misma corrida; los
// archivos de corridas anteriores SI se pisan (re-correr actualiza en el lugar,
// sin dejar duplicados _1). Se resetea al empezar cada corrida.
const downloadedThisRun = new Set<string>();

export function resetDownloadedThisRun(): void {
  downloadedThisRun.clear();
}

/**
 * Descarga un archivo siguiendo redirecciones. Si Moodle devuelve la pagina
 * intermedia HTML ("resourceworkaround"), busca dentro el link real y recursa.
 * Devuelve la ruta escrita o null.
 */
export async function downloadFile(
  session: Session,
  url: string,
  destDir: string,
): Promise<string | null> {
  let response;
  try {
    response = await session.get(url);
  } catch (e) {
    console.log(`    [!] Error al descargar ${url}: ${e instanceof Error ? e.message : e}`);
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  // Si nos devuelve una pagina HTML, no es un archivo: buscamos dentro el link
  // real (pagina intermedia de Moodle "resourceworkaround").
  if (contentType.includes('text/html')) {
    const $ = cheerio.load(await response.text());
    const link = $('.resourceworkaround a, .resourcecontent a, object[data], iframe[src]').first();
    const real = link.attr('href') ?? link.attr('data') ?? link.attr('src');
    if (real) {
      return downloadFile(session, new URL(real, url).href, destDir);
    }
    return null; // era una pagina de verdad, no un archivo
  }

  // Nombre desde Content-Disposition o, si no viene, desde la URL final.
  let fileName = '';
  const contentDisposition = response.headers.get('content-disposition') ?? '';
  const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/);
  if (match) {
    fileName = decodeURIComponent(match[1]);
  }
  if (!fileName) {
    fileName = basename(new URL(response.url).pathname) || 'archivo';
  }

  fileName = sanitize(fixMojibake(fileName));
  await mkdir(destDir, { recursive: true });
  let dest = join(destDir, fileName);

  // Solo agregamos sufijo si en ESTA corrida ya escribimos ese nombre.
  const ext = extname(dest);
  const base = dest.slice(0, dest.length - ext.length);
  let suffix = 1;
  while (downloadedThisRun.has(dest)) {
    dest = `${base}_${suffix}${ext}`;
    suffix++;
  }
  downloadedThisRun.add(dest);

  if (!response.body) {
    console.log(`    [!] Respuesta sin cuerpo: ${basename(dest)}`);
    return null;
  }
  try {
    // fetch tipa el body con el ReadableStream global; Readable.fromWeb espera
    // el de node:stream/web. Son el mismo objeto en runtime; salvamos el tipo.
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      createWriteStream(dest),
    );
  } catch {
    // El archivo esta abierto/bloqueado (ej: PDF abierto en un visor) -> EBUSY/EPERM.
    console.log(`    [!] No se pudo escribir (en uso): ${basename(dest)}`);
    return null;
  }
  console.log(`    [archivo] ${basename(dest)}`);
  return dest;
}
