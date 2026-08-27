import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import * as cheerio from 'cheerio';
import { BASE_URL, FILE_HINT_EXT, OUTPUT_DIR } from './config.js';
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
interface CourseContext {
  session: Session;
  courseDir: string;
  filesDir: string;
  markdown: string[];
  seenHrefs: Set<string>;
  unhandled: Map<string, string>;
}

/** Extrae el tipo de modulo de una URL de Moodle: /mod/<tipo>/ -> "<tipo>". */
function moduleType(href: string): string | null {
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
async function processActivities(
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

    // Fechas de apertura/cierre que Moodle muestra inline en cada actividad
    // (tareas, cuestionarios). Clave para no perder deadlines.
    const activityDates = cleanText(
      activity.find('[data-region="activity-dates"], .activity-dates').text(),
    );
    const datesSuffix = activityDates ? `  _(${activityDates})_` : '';

    if (type === 'resource' || FILE_HINT_EXT.some((ext) => href.toLowerCase().endsWith(ext))) {
      const path = await downloadFile(ctx.session, href, ctx.filesDir, sanitize(name));
      if (path) {
        ctx.markdown.push(`- [${name}](${relativeToCourse(ctx.courseDir, path)})${datesSuffix}`);
      } else {
        ctx.markdown.push(`- ${name} (${href})${datesSuffix}`);
      }
    } else if (type === 'folder') {
      ctx.markdown.push(`- **${name}**${datesSuffix}`);
      for (const path of await handleFolder(ctx.session, href, ctx.filesDir)) {
        ctx.markdown.push(`    - [${basename(path)}](${relativeToCourse(ctx.courseDir, path)})`);
      }
    } else if (type === 'forum') {
      console.log(`    [foro] ${name}`);
      ctx.markdown.push(`\n### Foro: [${name}](${href})\n`);
      const text = await handleForum(ctx.session, href);
      ctx.markdown.push(text.trim() ? text : '_(sin mensajes)_');
    } else if (type === 'page') {
      console.log(`    [pagina] ${name}`);
      ctx.markdown.push(`\n### Página: [${name}](${href})\n`);
      ctx.markdown.push((await handlePage(ctx.session, href)) || '_(vacio)_');
    } else if (type === 'book') {
      console.log(`    [libro] ${name}`);
      ctx.markdown.push(`\n### Libro: [${name}](${href})\n`);
      ctx.markdown.push((await handleBook(ctx.session, href)) || '_(vacio)_');
    } else if (type === 'url') {
      const target = await handleUrl(ctx.session, href);
      ctx.markdown.push(`- [${name}](${target})${datesSuffix}`);
    } else if (type === 'assign' || type === 'quiz' || type === 'workshop') {
      ctx.markdown.push(`- [${name}](${href})  _(actividad: ${type})_${datesSuffix}`);
    } else {
      // Tipo sin handler dedicado. En vez de dejarlo como un link mudo, lo
      // escaneamos por videos/embeds y registramos el tipo para avisarlo al
      // final, asi nada escondido pasa desapercibido.
      ctx.unhandled.set(type ?? '?', name);
      ctx.markdown.push(`- [${name}](${href})  _(tipo sin handler: ${type})_${datesSuffix}`);
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

/**
 * Busca el nombre real de una seccion (numero secNum) en los links de pestaña de
 * la pagina. Prefiere la pestaña marcada como activa. Ignora etiquetas de
 * navegacion genericas ("Curso", "Más").
 */
function sectionNameFrom($: cheerio.CheerioAPI, secNum: string): string {
  let best = '';
  for (const element of $("a[href*='section=']").toArray()) {
    const match = ($(element).attr('href') ?? '').match(/[?&]section=(\d+)/);
    if (!match || match[1] !== secNum) continue;
    const text = cleanText($(element).text());
    if (!text || ['curso', 'más', 'more', 'general'].includes(text.toLowerCase())) continue;
    const li = $(element).closest('li');
    if (li.length && li.hasClass('active')) return text;
    best = best || text;
  }
  return best;
}

/**
 * Agrega a la cola las secciones (?section=N) enlazadas en el contenedor que
 * todavia no vimos. Asi capturamos tambien subsecciones anidadas dentro de una
 * pestaña, no solo la barra principal.
 */
function collectSections(
  $: cheerio.CheerioAPI,
  container: CheerioNode,
  courseUrl: string,
  queue: Array<{ name: string; url: string }>,
  seenSections: Set<string>,
): void {
  for (const element of container.find("a[href*='section=']").toArray()) {
    const href = $(element).attr('href') ?? '';
    const match = href.match(/[?&]section=(\d+)/);
    if (!match || seenSections.has(match[1])) continue;
    seenSections.add(match[1]);
    const name = cleanText($(element).text()) || `Sección ${match[1]}`;
    queue.push({ name, url: new URL(href, courseUrl).href });
  }
}

/**
 * Procesa una materia entera: detecta el nombre, recorre sus secciones (con
 * soporte para el formato con pestañas onetopic) y guarda el Markdown resultante
 * en OUTPUT_DIR/<materia>/<materia>.md, con los archivos en su subcarpeta.
 */
export async function processCourse(session: Session, courseId: number): Promise<void> {
  const url = new URL(`/course/view.php?id=${courseId}`, BASE_URL).href;
  const response = await session.get(url);
  const $ = cheerio.load(await response.text());

  const titleElement = $('h1, .page-header-headings h1, title').first();
  const courseName = titleElement.length
    ? sanitize(cleanText(titleElement.text()))
    : `curso_${courseId}`;
  console.log(`\n=== Materia: ${courseName} (id=${courseId}) ===`);

  const courseDir = join(OUTPUT_DIR, courseName);
  const filesDir = join(courseDir, 'archivos');
  await mkdir(courseDir, { recursive: true });

  const ctx: CourseContext = {
    session,
    courseDir,
    filesDir,
    markdown: [`# ${courseName}\n`, `_Fuente: ${url}_\n`],
    seenHrefs: new Set(),
    unhandled: new Map(),
  };

  // ¿El curso usa formato con pestañas (onetopic)? En ese caso la pagina solo
  // muestra la pestaña activa; el resto del material esta en otras "secciones"
  // que se cargan con ?id=..&section=N.
  const bodyClasses = $('body').attr('class') ?? '';
  const tabbed = bodyClasses.includes('format-onetopic') || bodyClasses.includes('format-tabs');

  const queue: Array<{ name: string; url: string }> = [];
  const seenSections = new Set<string>();

  if (tabbed) {
    collectSections($, $('html'), url, queue, seenSections);
    // Ademas de las secciones enlazadas, probamos todos los numeros de seccion
    // (0..max+5) para no perder secciones "huerfanas" no enlazadas en ninguna
    // pestaña visible (ej: subtemas de segundo nivel).
    const nums = [...seenSections].map(Number);
    const maxNum = nums.length ? Math.max(...nums) : 0;
    for (let n = 0; n <= maxNum + 5; n++) {
      if (!seenSections.has(String(n))) {
        seenSections.add(String(n));
        queue.push({
          name: `Sección ${n}`,
          url: new URL(`/course/view.php?id=${courseId}&section=${n}`, BASE_URL).href,
        });
      }
    }
  }

  if (queue.length) {
    // Crawl por anchura de TODAS las secciones/pestañas del curso.
    console.log('    [i] Curso con pestañas — recorriendo secciones...');
    while (queue.length) {
      const tab = queue.shift();
      if (!tab) break;
      const tabResponse = await session.get(tab.url);
      const $tab = cheerio.load(await tabResponse.text());
      const region = $tab('#region-main').length ? $tab('#region-main') : $tab('html');

      // Si el nombre es generico (viene del probeo), buscamos el nombre real.
      let tabName = tab.name;
      if (tabName.startsWith('Sección ')) {
        const match = tab.url.match(/[?&]section=(\d+)/);
        const real = match ? sectionNameFrom($tab, match[1]) : '';
        if (real) tabName = real;
      }

      const before = ctx.markdown.length;
      ctx.markdown.push(`\n## ${tabName}\n`);
      await processActivities(ctx, $tab, region);
      if (ctx.markdown.length === before + 1) ctx.markdown.pop(); // seccion vacia

      // Descubrir subsecciones enlazadas dentro de esta seccion.
      collectSections($tab, region, url, queue, seenSections);
    }
  } else {
    // Curso clasico por secciones. Probamos selectores en orden y usamos el
    // primero que devuelva resultados, para no contar contenedores anidados.
    let sectionNodes = $('li.section');
    if (!sectionNodes.length) sectionNodes = $('.course-section');
    if (!sectionNodes.length) sectionNodes = $("[data-for='section']");
    const containers = sectionNodes.length
      ? sectionNodes.toArray().map((element) => $(element))
      : [$('html')];

    for (const section of containers) {
      const sectionTitleElement = section
        .find('.sectionname, h3.sectionname, .section-title')
        .first();
      const sectionTitle = sectionTitleElement.length ? cleanText(sectionTitleElement.text()) : '';
      const before = ctx.markdown.length;
      if (sectionTitle) ctx.markdown.push(`\n## ${sectionTitle}\n`);
      await processActivities(ctx, $, section);
      if (sectionTitle && ctx.markdown.length === before + 1) ctx.markdown.pop();
    }
  }

  const mdPath = join(courseDir, `${courseName}.md`);
  await writeFile(mdPath, ctx.markdown.join('\n'), 'utf-8');
  console.log(`[OK] Markdown guardado: ${mdPath}`);

  if (ctx.unhandled.size) {
    console.log(
      '    [AVISO] Tipos de recurso sin handler dedicado en esta materia (revisar si esconden material):',
    );
    for (const [type, example] of ctx.unhandled) {
      console.log(`            - mod/${type}  (ej: "${example}")`);
    }
  }
}
