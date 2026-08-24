import { execFileSync } from 'node:child_process';
import { CRED_TARGET } from './config.js';
import { buildCredentialScript } from './credential-script.js';

/**
 * Lee la credencial del Windows Credential Manager (credencial genérica cuyo
 * target es CRED_TARGET). Ejecuta un script PowerShell (ver credential-script.ts)
 * que llama a la API CredRead de Windows. Sin dependencias npm nativas. El
 * usuario y la clave viajan por stdout en memoria, nunca a disco ni se imprimen.
 */
export function loadCredentials(): { user: string; password: string } {
  const encoded = Buffer.from(buildCredentialScript(CRED_TARGET), 'utf16le').toString('base64');
  let output: string;
  try {
    output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 15000 },
    );
  } catch (e) {
    throw new Error(
      `No se pudo leer el Windows Credential Manager: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (output.includes('NOTFOUND')) {
    throw new Error(
      `No se encontró la credencial "${CRED_TARGET}" en Windows Credential Manager. ` +
        'Cargala en "Administrador de credenciales" -> Credenciales genéricas.',
    );
  }

  let user = '';
  let password = '';
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('USER=')) user = line.slice(5);
    else if (line.startsWith('PASS=')) password = line.slice(5);
  }
  if (!user || !password) {
    throw new Error(`Credencial "${CRED_TARGET}" incompleta (falta usuario o clave).`);
  }
  return { user, password };
}
