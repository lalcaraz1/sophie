import * as cheerio from 'cheerio';
import { BASE_URL } from './config.js';
import type { Session } from './session.js';
import { cleanText, htmlToMd } from './util.js';

type CheerioNode = ReturnType<cheerio.CheerioAPI>;

/**
 * Convierte un embed de YouTube (embed/XXX o youtu.be/XXX) en un link normal
 * para ver: https://www.youtube.com/watch?v=XXX
 */
function normalizeVideoUrl(u: string): string {
  const match = u.match(/(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]+)/);
  return match ? `https://www.youtube.com/watch?v=${match[1]}` : u;
}

/**
 * Saca los videos/recursos embebidos (iframes, <video>, links a youtube/vimeo/
 * drive) que la conversion a Markdown descarta. Devuelve URLs unicas, en orden.
 */
export function extractEmbeds(
  $: cheerio.CheerioAPI,
  container: CheerioNode,
  base: string,
): string[] {
  const embeds: string[] = [];
  const selector =
    "iframe[src], video source[src], video[src], " +
    "a[href*='youtu'], a[href*='vimeo'], a[href*='drive.google']";
  for (const element of container.find(selector).toArray()) {
    const src = $(element).attr('src') ?? $(element).attr('href');
    if (!src) continue;
    const full = normalizeVideoUrl(new URL(src, base).href);
    if (full.startsWith('http') && !full.includes('about:blank')) {
      embeds.push(full);
    }
  }
  return [...new Set(embeds)];
}

/**
 * Pagina de Moodle (mod/page): devuelve su contenido como Markdown, incluyendo
 * los videos embebidos (que de otro modo se perderian).
 */
export async function handlePage(session: Session, url: string): Promise<string> {
  const response = await session.get(url);
  const $ = cheerio.load(await response.text());

  const regionSelection = $('#region-main');
  const region = regionSelection.length ? regionSelection : $('html');
  const mainSelection = $(
    "[role='main'] .box.generalbox, #region-main .no-overflow, " +
    "#region-main [role='main'], #region-main",
  ).first();
  const main = mainSelection.length ? mainSelection : region;

  let markdown = htmlToMd($.html(main));
  const embeds = extractEmbeds($, region, url);
  if (embeds.length) {
    markdown += '\n\n**Video(s):**\n' + embeds.map((embed) => `- <${embed}>`).join('\n');
  }
  return markdown.trim();
}

/**
 * Libro de Moodle (mod/book): recorre todos los capitulos y devuelve su
 * contenido en Markdown + los videos embebidos de cada uno. Aca es donde la
 * catedra suele subir las grabaciones de las clases sincronicas.
 */
export async function handleBook(session: Session, url: string): Promise<string> {
  const out: string[] = [];
  const response = await session.get(url);
  const $ = cheerio.load(await response.text());

  // Tabla de contenidos: junto los chapterid de todos los capitulos. Los links
  // del indice suelen ser RELATIVOS (view.php?id=..&chapterid=..), asi que los
  // detectamos por el parametro chapterid despues de resolver la URL.
  let toc = $('.book_toc, [class*="book_toc"]').first();
  if (!toc.length) toc = $('#region-main').first();
  if (!toc.length) toc = $('html');

  const chapters: string[] = [];
  const seen = new Set<string>();

  // El capitulo activo (el que muestra la pagina base) suele venir SIN link o
  // resaltado. Guardamos su chapterid para no duplicarlo, y agregamos siempre la
  // pagina base como primer capitulo.
  const active = toc.find('.active a[href], [class*="active"] a[href], strong a[href]').first();
  if (active.length) {
    const activeId = new URL(active.attr('href') ?? '', url).searchParams.get('chapterid');
    if (activeId) seen.add(activeId);
  }
  chapters.push(url);

  for (const anchor of toc.find('a[href]').toArray()) {
    const full = new URL($(anchor).attr('href') ?? '', url).href;
    const chapterId = new URL(full).searchParams.get('chapterid');
    if (chapterId && !seen.has(chapterId)) {
      seen.add(chapterId);
      chapters.push(full);
    }
  }

  for (const chapterUrl of chapters) {
    const chapterResponse = await session.get(chapterUrl);
    const $chapter = cheerio.load(await chapterResponse.text());

    const regionSelection = $chapter('#region-main');
    const region = regionSelection.length ? regionSelection : $chapter('html');
    const contentSelection = $chapter('.book_content').first();
    const content = contentSelection.length ? contentSelection : region;

    let titleElement = content.find('h3, h2').first();
    if (!titleElement.length) titleElement = region.find('h2').first();
    const title = titleElement.length ? cleanText(titleElement.text()) : '';
    if (title) out.push(`#### ${title}\n`);

    out.push(htmlToMd($chapter.html(content)));
    const embeds = extractEmbeds($chapter, region, chapterUrl);
    if (embeds.length) {
      out.push(
        '\n**Grabación(es)/video(s):**\n' + embeds.map((embed) => `- <${embed}>`).join('\n'),
      );
    }
    out.push('');
  }
  return out.join('\n').trim();
}

/**
 * Foro de Moodle: devuelve texto Markdown con cada discusion y sus mensajes.
 */
export async function handleForum(session: Session, url: string): Promise<string> {
  const out: string[] = [];
  const response = await session.get(url);
  const $ = cheerio.load(await response.text());

  // Cada hilo aparece varias veces en la tabla (asunto, autor, fecha...), asi
  // que deduplicamos por el id de la discusion (?d=) y nos quedamos con el primer
  // titulo, que es el del asunto.
  const discussions: Array<{ title: string; url: string }> = [];
  const seenDiscussions = new Set<string>();
  for (const anchor of $("a[href*='discuss.php']").toArray()) {
    const href = $(anchor).attr('href');
    const title = cleanText($(anchor).text());
    if (!href || !title) continue;
    const discussionUrl = new URL(href, url).href;
    const discussionId = new URL(discussionUrl).searchParams.get('d') ?? discussionUrl;
    if (seenDiscussions.has(discussionId)) continue;
    seenDiscussions.add(discussionId);
    discussions.push({ title, url: discussionUrl });
  }

  if (discussions.length === 0) return '';

  for (const discussion of discussions) {
    out.push(`### ${discussion.title}\n`);
    const discussionResponse = await session.get(discussion.url);
    const $discussion = cheerio.load(await discussionResponse.text());

    // Igual que con secciones: usamos el primer selector que devuelva resultados
    // para no matchear elementos anidados dos veces.
    let posts = $discussion("[data-region='post']");
    if (!posts.length) posts = $discussion('.forumpost');
    if (!posts.length) posts = $discussion('article.forum-post-container');

    for (const post of posts.toArray()) {
      const $post = $discussion(post);
      const author = cleanText(
        $post.find(".author, [data-region-content='forum-post-core-author']").first().text(),
      );
      const subject = cleanText($post.find('.subject, h3, h4').first().text());
      const bodyElement = $post
        .find(".posting, .post-content-container, [data-region-content='forum-post-core-message']")
        .first();
      const body = bodyElement.length ? htmlToMd($discussion.html(bodyElement)) : '';

      const head = [subject, author].filter(Boolean).join(' — ');
      if (head) out.push(`**${head}**\n`);
      if (body) out.push(body + '\n');
    }
    out.push('');
  }
  return out.join('\n');
}

/** Recurso tipo URL de Moodle (mod/url): devuelve el link externo real. */
export async function handleUrl(session: Session, url: string): Promise<string> {
  let response;
  try {
    response = await session.get(url);
  } catch {
    return url;
  }
  if (!response.url.includes(BASE_URL)) {
    return response.url; // redirigio directo al destino externo
  }
  const $ = cheerio.load(await response.text());
  const anchor = $(".urlworkaround a[href], #region-main a[href^='http']").first();
  const href = anchor.attr('href');
  if (href && !href.includes(BASE_URL)) {
    return new URL(href, url).href;
  }
  return normalizeVideoUrl(response.url);
}
