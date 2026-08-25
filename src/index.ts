import * as cheerio from 'cheerio';
import { BASE_URL } from './config.js';
import { Session } from './session.js';
import { login } from './auth.js';
import { loadCredentials } from './credentials.js';
import { fetchEnrolledCourses } from './discovery.js';
import { handleBook, handleForum, handlePage, handleUrl } from './handlers.js';

function firstAbsoluteHref($: cheerio.CheerioAPI, selector: string): string | undefined {
  const href = $(selector).first().attr('href');
  return href ? new URL(href, BASE_URL).href : undefined;
}

function preview(label: string, markdown: string): void {
  console.log(`\n===== ${label} =====`);
  console.log(markdown ? markdown.slice(0, 600) : '(vacio)');
}

async function main(): Promise<void> {
  const { user, password } = loadCredentials();
  console.log(`[i] Credenciales leidas del Credential Manager (usuario: ${user})`);

  const session = new Session();
  await login(session, user, password);

  const courses = await fetchEnrolledCourses(session);
  console.log(`[i] materias descubiertas: ${courses.length}`);

  // Smoke test Fase 3: junta la primera pagina, foro y libro que aparezcan en
  // las portadas de las materias y muestra el Markdown de cada handler.
  // Codigo temporal; en la Fase 5 index.ts pasa a main real.
  let pageUrl: string | undefined;
  let forumUrl: string | undefined;
  let bookUrl: string | undefined;
  let urlUrl: string | undefined;
  for (const course of courses) {
    const coursePage = await session.get(new URL(`/course/view.php?id=${course.id}`, BASE_URL).href);
    const $ = cheerio.load(await coursePage.text());
    pageUrl ??= firstAbsoluteHref($, "a[href*='mod/page/view.php']");
    forumUrl ??= firstAbsoluteHref($, "a[href*='mod/forum/view.php']");
    bookUrl ??= firstAbsoluteHref($, "a[href*='mod/book/view.php']");
    urlUrl ??= firstAbsoluteHref($, "a[href*='mod/url/view.php']");
    if (pageUrl && forumUrl && bookUrl && urlUrl) break;
  }

  if (pageUrl) preview('PAGINA', await handlePage(session, pageUrl));
  else console.log('[test] no encontre ninguna pagina (mod/page).');

  if (forumUrl) preview('FORO', await handleForum(session, forumUrl));
  else console.log('[test] no encontre ningun foro (mod/forum).');

  if (bookUrl) preview('LIBRO', await handleBook(session, bookUrl));
  else console.log('[test] no encontre ningun libro (mod/book).');

  if (urlUrl) preview('URL', await handleUrl(session, urlUrl));
  else console.log('[test] no encontre ningun recurso URL (mod/url).');
}

main().catch((e) => {
  console.error('[ERROR]', e instanceof Error ? e.message : e);
  process.exit(1);
});
