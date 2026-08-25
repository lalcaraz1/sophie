import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { BASE_URL } from './config.js';
import { Session } from './session.js';
import { login } from './auth.js';
import { loadCredentials } from './credentials.js';
import { fetchEnrolledCourses } from './discovery.js';
import { resetDownloadedThisRun } from './download.js';
import { type CourseContext, processActivities } from './course.js';

async function main(): Promise<void> {
  resetDownloadedThisRun();

  const { user, password } = loadCredentials();
  console.log(`[i] Credenciales leidas del Credential Manager (usuario: ${user})`);

  const session = new Session();
  await login(session, user, password);

  const courses = await fetchEnrolledCourses(session);
  console.log(`[i] materias descubiertas: ${courses.length}`);

  // Smoke test Fase 4: corre el dispatcher sobre el region-main de cada materia
  // y muestra un resumen + las primeras lineas del Markdown resultante.
  // Codigo temporal; en la Fase 5 index.ts pasa a main real.
  for (const course of courses) {
    const coursePage = await session.get(new URL(`/course/view.php?id=${course.id}`, BASE_URL).href);
    const $ = cheerio.load(await coursePage.text());
    const region = $('#region-main').length ? $('#region-main') : $('html');

    const testDir = join(process.cwd(), 'material', '_test', String(course.id));
    const ctx: CourseContext = {
      session,
      courseDir: testDir,
      filesDir: join(testDir, 'archivos'),
      markdown: [],
      seenHrefs: new Set(),
      unhandled: new Map(),
    };
    await processActivities(ctx, $, region);

    console.log(`\n===== ${course.name} =====`);
    const unhandled = [...ctx.unhandled.keys()].join(', ') || '(ninguno)';
    console.log(`lineas de markdown: ${ctx.markdown.length} | tipos sin handler: ${unhandled}`);
    console.log(ctx.markdown.join('\n').split('\n').slice(0, 25).join('\n'));
  }
}

main().catch((e) => {
  console.error('[ERROR]', e instanceof Error ? e.message : e);
  process.exit(1);
});
