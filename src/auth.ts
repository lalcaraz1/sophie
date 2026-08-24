import * as cheerio from 'cheerio';
import { BASE_URL } from './config.js';
import type { Session } from './session.js';

/** Inicia sesion en el campus (maneja el logintoken anti-CSRF de Moodle). */
export async function login(
  session: Session,
  username: string,
  password: string,
): Promise<void> {
  const loginUrl = new URL('/login/index.php', BASE_URL).href;

  // 1) Traemos la pagina de login para extraer el logintoken (anti-CSRF de Moodle).
  const loginPage = await session.get(loginUrl);
  const $ = cheerio.load(await loginPage.text());
  const loginToken = $('input[name="logintoken"]').attr('value') ?? '';

  // 2) Enviamos el formulario con usuario, clave y token.
  const loginResponse = await session.post(loginUrl, {
    username,
    password,
    logintoken: loginToken,
  });
  const loginHtml = await loginResponse.text();

  // Si seguimos en /login/ o hay mensaje de error, el login fallo.
  if (
    loginResponse.url.includes('/login/index.php') ||
    loginHtml.includes('loginerrors') ||
    loginHtml.includes('Invalid login')
  ) {
    const $error = cheerio.load(loginHtml);
    const errorMessage =
      $error('.loginerrors').first().text().trim() ||
      $error('#loginerrormessage').first().text().trim();
    throw new Error(`No se pudo iniciar sesion: ${errorMessage || 'usuario o clave incorrectos'}`);
  }

  console.log('[OK] Sesion iniciada correctamente.');
}
