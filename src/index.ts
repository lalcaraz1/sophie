import { Session } from './session.js';
import { login } from './auth.js';
import { loadCredentials } from './credentials.js';
import { fetchEnrolledCourses } from './discovery.js';

async function main(): Promise<void> {
  const { user, password } = loadCredentials();
  console.log(`[i] Credenciales leidas del Credential Manager (usuario: ${user})`);

  const session = new Session();
  await login(session, user, password);

  // Smoke test Fase 1: login + auto-descubrimiento de materias inscriptas.
  const courses = await fetchEnrolledCourses(session);
  console.log(`[test] materias descubiertas: ${courses.length}`);
  for (const c of courses) {
    console.log(`  - ${c.id}: ${c.name}`);
  }
  if (courses.length === 0) {
    console.log('[!] 0 materias descubiertas (ni por HTML ni por AJAX).');
  }
}

main().catch((e) => {
  console.error('[ERROR]', e instanceof Error ? e.message : e);
  process.exit(1);
});
