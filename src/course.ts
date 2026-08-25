import { basename, relative } from 'node:path';
import * as cheerio from 'cheerio';
import { BASE_URL, FILE_HINT_EXT } from './config.js';
import type { Session } from './session.js';
import { cleanText, htmlToMd, sanitize } from './util.js';
import { downloadFile, handleFolder } from './download.js';
import { extractEmbeds, handleBook, handleForum, handlePage, handleUrl } from './handlers.js';

type CheerioNode = ReturnType<cheerio.CheerioAPI>;

/**
 * Estado que se acumula mientras se procesa una materia entera. Lo comparten
 * todas las secciones: `markdown` junta la salida, `seenHrefs` evita procesar el
 * mismo recurso dos veces, y `unhandled` registra los tipos sin handler dedicado.
 */
export interface CourseContext {
  session: Session;
  courseDir: string;
  filesDir: string;
  markdown: string[];
  seenHrefs: Set<string>;
  unhandled: Map<string, string>;
}

/** Extrae el tipo de modulo de una URL de Moodle: /mod/<tipo>/ -> "<tipo>". */
export function moduleType(href: string): string | null {
  const match = href.match(/\/mod\/(\w+)\//);
  return match ? match[1] : null;
}

/** Ruta relativa a la carpeta de la materia, con separadores POSIX para el Markdown. */
function relativeToCourse(courseDir: string, path: string): string {
  return relative(courseDir, path).replaceAll('\\', '/');
}

/**
 * Procesa todas las actividades dentro de un contenedor (una seccion o el
 * region-main de una pestaña) y vuelca su resultado en `ctx.markdown`.
 */
export async function processActivities(
  ctx: CourseContext,
  $: cheerio.CheerioAPI,
  container: CheerioNode,
): Promise<void> {
  let activities = container.find('li.activity');
  if (!activities.length) activities = container.find('.activity-item');
  if (!activities.length) activities = container.find('div.activityinstance');

  for (const element of activities.toArray()) {
    const activity = $(element);

    // Las "labels" (bloques de texto) suelen tener VARIOS links (ej: los mini
    // proyectos por semana). Volcamos su contenido COMPLETO en Markdown, con
    // todos sus links, no solo el primero.
    if (activity.hasClass('label')) {
      const moduleId = activity.attr('id') ?? '';
      const key = 'label:' + (moduleId || $.html(activity).slice(0, 150));
      if (ctx.seenHrefs.has(key)) continue;
      ctx.seenHrefs.add(key);
      const contentSelection = activity
        .find('.no-overflow, .activity-altcontent, .contentwithoutlink, .contentafterlink, .description')
        .first();
      const content = contentSelection.length ? contentSelection : activity;
      const text = htmlToMd($.html(content)).trim();
      if (text) ctx.markdown.push(text + '\n');
      continue;
    }

    const anchor = activity.find('a[href]').first();
    if (!anchor.length) {
      // Etiqueta/texto sin clase 'label' pero sin link primario.
      const label = activity.find('.contentafterlink, .no-overflow, .description').first();
      if (label.length) {
        const text = htmlToMd($.html(label));
        if (text.trim()) ctx.markdown.push(text + '\n');
      }
      continue;
    }

    const href = new URL(anchor.attr('href') ?? '', BASE_URL).href;
    if (ctx.seenHrefs.has(href)) continue;
    ctx.seenHrefs.add(href);
    const name = cleanText(anchor.text()) || href;
    const type = moduleType(href);

    if (type === 'resource' || FILE_HINT_EXT.some((ext) => href.toLowerCase().endsWith(ext))) {
      const path = await downloadFile(ctx.session, href, ctx.filesDir, sanitize(name));
      if (path) {
        ctx.markdown.push(`- [${name}](${relativeToCourse(ctx.courseDir, path)})`);
      } else {
        ctx.markdown.push(`- ${name} (${href})`);
      }
    } else if (type === 'folder') {
      ctx.markdown.push(`- **${name}**`);
      for (const path of await handleFolder(ctx.session, href, ctx.filesDir)) {
        ctx.markdown.push(`    - [${basename(path)}](${relativeToCourse(ctx.courseDir, path)})`);
      }
    } else if (type === 'forum') {
      console.log(`    [foro] ${name}`);
      ctx.markdown.push(`\n### Foro: ${name}\n`);
      const text = await handleForum(ctx.session, href);
      ctx.markdown.push(text.trim() ? text : '_(sin mensajes)_');
    } else if (type === 'page') {
      console.log(`    [pagina] ${name}`);
      ctx.markdown.push(`\n### Página: ${name}\n`);
      ctx.markdown.push((await handlePage(ctx.session, href)) || '_(vacio)_');
    } else if (type === 'book') {
      console.log(`    [libro] ${name}`);
      ctx.markdown.push(`\n### Libro: ${name}\n`);
      ctx.markdown.push((await handleBook(ctx.session, href)) || '_(vacio)_');
    } else if (type === 'url') {
      const target = await handleUrl(ctx.session, href);
      ctx.markdown.push(`- [${name}](${target})`);
    } else if (type === 'assign' || type === 'quiz' || type === 'workshop') {
      ctx.markdown.push(`- [${name}](${href})  _(actividad: ${type})_`);
    } else {
      // Tipo sin handler dedicado. En vez de dejarlo como un link mudo, lo
      // escaneamos por videos/embeds y registramos el tipo para avisarlo al
      // final, asi nada escondido pasa desapercibido.
      ctx.unhandled.set(type ?? '?', name);
      ctx.markdown.push(`- [${name}](${href})  _(tipo sin handler: ${type})_`);
      try {
        const response = await ctx.session.get(href);
        const $page = cheerio.load(await response.text());
        const regionSelection = $page('#region-main');
        const region = regionSelection.length ? regionSelection : $page('html');
        const embeds = extractEmbeds($page, region, href);
        for (const embed of embeds) ctx.markdown.push(`    - ${embed}`);
        if (embeds.length) {
          console.log(
            `    [!] '${name}' (tipo ${type}) tenia ${embeds.length} video(s) embebido(s) - revisar si merece handler`,
          );
        }
      } catch {
        // Ignoramos: el escaneo de embeds es best-effort.
      }
    }
  }
}
