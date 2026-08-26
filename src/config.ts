import { join } from 'node:path';

export const BASE_URL = 'https://frgp.cvg.utn.edu.ar';

// Credenciales: se leen del Windows Credential Manager.
export const CRED_TARGET = 'utn-campus';

// Carpeta donde se guarda todo el material descargado.
export const OUTPUT_DIR = join(process.cwd(), 'material');

// Extensiones que consideramos "archivo a descargar" cuando el link no es un
// modulo mod/resource pero apunta directo a un archivo.
export const FILE_HINT_EXT = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z', '.txt', '.csv', '.odt', '.ods', '.odp',
  '.png', '.jpg', '.jpeg', '.gif', '.mp3', '.mp4', '.ipynb', '.py',
];
