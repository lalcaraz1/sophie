import { BASE_URL } from './config.js';
import type { Session } from './session.js';

interface DiscoveredCourse {
  id: number;
  name: string;
}

/** Forma (parcial) de la respuesta del endpoint AJAX de Moodle. */
interface MoodleTimelineCourse {
  id: number;
  fullname?: string;
  shortname?: string;
}

interface MoodleAjaxResult {
  error: boolean;
  exception?: { message?: string };
  data?: { courses?: MoodleTimelineCourse[] };
}

/**
 * Descubre las materias en las que el usuario está inscripto.
 *
 * La página "Mis cursos" de Moodle 4.x renderiza la lista de cursos por
 * JavaScript, así que el HTML crudo no la trae. Vamos directo al mismo endpoint
 * de servicio que usa el dashboard por detrás:
 * core_course_get_enrolled_courses_by_timeline_classification, que devuelve las
 * materias como JSON.
 */
export async function fetchEnrolledCourses(session: Session): Promise<DiscoveredCourse[]> {
  // El sesskey (token anti-CSRF de Moodle) viene embebido en cualquier página
  // logueada (en el objeto M.cfg).
  const dashboard = await session.get(new URL('/my/', BASE_URL).href);
  const dashboardHtml = await dashboard.text();
  const sesskeyMatch = dashboardHtml.match(/"sesskey":"([^"]+)"/);
  if (!sesskeyMatch) throw new Error('No pude extraer el sesskey (¿sesión no iniciada?).');
  const sesskey = sesskeyMatch[1];

  const method = 'core_course_get_enrolled_courses_by_timeline_classification';
  const url = new URL(
    `/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=${method}`,
    BASE_URL,
  ).href;
  const payload = [
    {
      index: 0,
      methodname: method,
      args: { offset: 0, limit: 0, classification: 'all', sort: 'fullname' },
    },
  ];

  const ajaxResponse = await session.postJson(url, payload);
  const parsed = JSON.parse(await ajaxResponse.text()) as MoodleAjaxResult[] | MoodleAjaxResult;
  const firstResult = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!firstResult || firstResult.error) {
    const message = firstResult?.exception?.message ?? 'desconocido';
    throw new Error(`Endpoint AJAX de Moodle devolvió error: ${message}`);
  }

  const courses = firstResult.data?.courses ?? [];
  return courses
    .map((course) => ({
      id: Number(course.id),
      name: String(course.fullname ?? course.shortname ?? '').trim(),
    }))
    .filter((course) => course.id > 1);
}
