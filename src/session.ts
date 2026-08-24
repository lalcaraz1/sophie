const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36';

/** Respuesta con la URL final ya resuelta tras seguir redirecciones. */
export interface HttpResponse {
  status: number;
  url: string; // URL final despues de redirects (equivalente a r.url de requests)
  text: () => Promise<string>;
}

/**
 * Sesion HTTP con cookie jar propio. `fetch` nativo NO maneja cookies ni las
 * reenvia entre redirecciones, asi que seguimos los redirects a mano (redirect:
 * 'manual') y en cada hop guardamos las cookies (Set-Cookie) y las mandamos de
 * vuelta. Sin esto, el login de Moodle no persiste la sesion.
 */
export class Session {
  private cookies = new Map<string, string>();

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private storeCookies(res: Response): void {
    const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
    for (const rawCookie of setCookieHeaders) {
      const nameValue = rawCookie.split(';', 1)[0];
      const eq = nameValue.indexOf('=');
      if (eq > 0) {
        this.cookies.set(nameValue.slice(0, eq).trim(), nameValue.slice(eq + 1).trim());
      }
    }
  }

  async get(url: string, timeoutMs = 60000): Promise<HttpResponse> {
    return this.request(url, 'GET', undefined, undefined, timeoutMs);
  }

  async post(
    url: string,
    body: Record<string, string>,
    timeoutMs = 60000,
  ): Promise<HttpResponse> {
    return this.request(
      url,
      'POST',
      new URLSearchParams(body).toString(),
      'application/x-www-form-urlencoded',
      timeoutMs,
    );
  }

  async postJson(url: string, data: unknown, timeoutMs = 60000): Promise<HttpResponse> {
    return this.request(url, 'POST', JSON.stringify(data), 'application/json', timeoutMs);
  }

  private async request(
    url: string,
    method: string,
    body: string | undefined,
    contentType: string | undefined,
    timeoutMs: number,
  ): Promise<HttpResponse> {
    let currentUrl = url;
    let curMethod = method;
    let curBody = body;
    const maxRedirects = 10;

    for (let i = 0; i < maxRedirects; i++) {
      const headers = new Headers();
      headers.set('User-Agent', UA);
      if (curBody !== undefined && contentType) {
        headers.set('Content-Type', contentType);
      }
      const cookie = this.cookieHeader();
      if (cookie) headers.set('Cookie', cookie);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(currentUrl, {
          method: curMethod,
          headers,
          body: curBody,
          redirect: 'manual',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      this.storeCookies(res);

      // Redireccion: resolvemos Location contra la URL actual y seguimos.
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (location) {
          await res.arrayBuffer().catch(() => { }); // liberar el socket
          currentUrl = new URL(location, currentUrl).href;
          // 303, o POST con 301/302 -> el navegador pasa a GET sin cuerpo.
          if (
            res.status === 303 ||
            ((res.status === 301 || res.status === 302) && curMethod === 'POST')
          ) {
            curMethod = 'GET';
            curBody = undefined;
          }
          continue;
        }
      }

      return {
        status: res.status,
        url: currentUrl,
        text: () => res.text(),
      };
    }
    throw new Error(`Demasiadas redirecciones: ${url}`);
  }
}
