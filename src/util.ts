import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

/** Convierte un fragmento de HTML a Markdown. */
export function htmlToMd(html: string): string {
  return turndown.turndown(html).trim();
}

/**
 * Colapsa espacios en blanco (incluidos saltos de linea) a un solo espacio y
 * recorta los extremos. cheerio no lo hace solo al leer .text(), a diferencia
 * del get_text de otros parsers.
 */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Convierte un texto en un nombre de archivo/carpeta valido en Windows:
 * reemplaza los caracteres prohibidos por "_", colapsa espacios y recorta.
 */
export function sanitize(name: string, maxLength = 120): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim()
    .replace(/^\.+|\.+$/g, '') // sin puntos al principio ni al final
    .replace(/\s+/g, ' ');
  return (cleaned || 'sin_nombre').slice(0, maxLength).trim();
}

/**
 * Corrige texto UTF-8 mal decodificado como latin-1 (Ã­->í, Ã±->ñ, NÂº->Nº).
 *
 * No adivina letra por letra: reinterpreta los bytes latin-1 como UTF-8. Ese
 * round-trip SOLO tiene exito cuando la cadena era realmente UTF-8 roto; si el
 * nombre ya estaba bien (o no es este problema), la decodificacion falla y
 * devolvemos el original intacto. Cubre todo el rango UTF-8 (acentos, ñ, ü,
 * ¿¡, guiones largos) sin riesgo de romper nombres sanos.
 */
export function fixMojibake(text: string): string {
  // Si algun code point no entra en un byte (> 0xFF), la cadena no puede
  // provenir de este problema: cortamos aca. Hace falta el chequeo explicito
  // porque Buffer.from(..., 'latin1') truncaria en silencio en vez de fallar.
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) return text;
  }
  try {
    const latin1Bytes = Buffer.from(text, 'latin1');
    return new TextDecoder('utf-8', { fatal: true }).decode(latin1Bytes);
  } catch {
    return text;
  }
}
