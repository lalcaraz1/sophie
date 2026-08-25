import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { BASE_URL } from './config.js';
import { Session } from './session.js';
import { login } from './auth.js';
import { loadCredentials } from './credentials.js';
import { fetchEnrolledCourses } from './discovery.js';
import { downloadFile, resetDownloadedThisRun } from './download.js';

async function main(): Promise<void> {
  resetDownloadedThisRun();

  const { user, password } = loadCredentials();
  console.log(`[i] Credenciales leidas del Credential Manager (usuario: ${user})`);

  const session = new Session();
  await login(session, user, password);

  const courses = await fetchEnrolledCourses(session);
  console.log(`[i] materias descubiertas: ${courses.length}`);
  if (courses.length === 0) {
    console.log('[!] Sin materias para probar la descarga.');
    return;
  }

  // Smoke test Fase 2: recorre las materias hasta encontrar un recurso
  // descargable y lo baja. Codigo temporal; en la Fase 5 index.ts pasa a main real.
  for (const course of courses) {
    const coursePage = await session.get(new URL(`/course/view.php?id=${course.id}`, BASE_URL).href);
    const $ = cheerio.load(await coursePage.text());
    const resourceHref = $("a[href*='mod/resource/view.php'], a[href*='pluginfile.php']")
      .first()
      .attr('href');
    if (!resourceHref) {
      console.log(`[test] ${course.name}: sin recursos, sigo con la proxima.`);
      continue;
    }
    console.log(`[test] descargando un recurso de: ${course.name}`);
    const destDir = join(process.cwd(), 'material', '_test');
    const saved = await downloadFile(session, new URL(resourceHref, BASE_URL).href, destDir);
    console.log(saved ? `[test] descargado en: ${saved}` : '[test] no se descargo nada.');
    return;
  }
  console.log('[!] Ninguna materia tenia recursos descargables en su portada.');
}

main().catch((e) => {
  console.error('[ERROR]', e instanceof Error ? e.message : e);
  process.exit(1);
});
