import { mkdir } from 'node:fs/promises';
import { OUTPUT_DIR } from './config.js';
import { Session } from './session.js';
import { login } from './auth.js';
import { loadCredentials } from './credentials.js';
import { fetchEnrolledCourses } from './discovery.js';
import { resetDownloadedThisRun } from './download.js';
import { processCourse } from './course.js';

async function main(): Promise<void> {
  console.log('== Descargador Moodle UTN FRGP ==');
  resetDownloadedThisRun();

  const { user, password } = loadCredentials();
  console.log(`[i] Credenciales leidas del Credential Manager (usuario: ${user})`);

  const session = new Session();
  await login(session, user, password);

  const courses = await fetchEnrolledCourses(session);
  console.log(`[i] materias descubiertas: ${courses.length}`);

  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const course of courses) {
    // try/catch por materia: si una falla, seguimos con las demas.
    try {
      await processCourse(session, course.id);
    } catch (e) {
      console.log(`[!] Error procesando la materia ${course.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(`\n== Listo. Todo quedo en: ${OUTPUT_DIR} ==`);
}

main().catch((e) => {
  console.error('[ERROR]', e instanceof Error ? e.message : e);
  process.exit(1);
});
