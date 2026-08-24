/**
 * Genera el script PowerShell que lee una credencial genérica del Windows
 * Credential Manager via la API CredRead (P/Invoke). credentials.ts lo ejecuta
 * con -EncodedCommand. Imprime "USER=<usuario>" y "PASS=<clave>" por stdout, o
 * "NOTFOUND" si la credencial no existe.
 */
export function buildCredentialScript(target: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$sig = @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class CredMan {',
    '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  public static extern bool CredRead(string target, int type, int flags, out IntPtr credentialPtr);',
    '  [DllImport("advapi32.dll")]',
    '  public static extern void CredFree(IntPtr cred);',
    '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
    '  public struct CREDENTIAL {',
    '    // El layout debe coincidir EXACTO con el struct nativo de Windows: no',
    '    // borrar ni reordenar campos aunque no se usen (el marshaling lee por',
    '    // offset de memoria; sacar uno corre todos los siguientes y rompe la lectura).',
    '    public int Flags; public int Type; public string TargetName; public string Comment;',
    '    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;',
    '    public int Persist; public int AttributeCount; public IntPtr Attributes;',
    '    public string TargetAlias; public string UserName;',
    '  }',
    '}',
    "'@",
    'try { Add-Type -TypeDefinition $sig } catch {}',
    '$ptr = [IntPtr]::Zero',
    `if ([CredMan]::CredRead("${target}", 1, 0, [ref]$ptr)) {`,
    '  $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type]([CredMan+CREDENTIAL]))',
    '  $pass = ""',
    '  if ($c.CredentialBlobSize -gt 0) {',
    '    $pass = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize / 2)',
    '  }',
    '  Write-Output ("USER=" + $c.UserName)',
    '  Write-Output ("PASS=" + $pass)',
    '  [CredMan]::CredFree($ptr)',
    '} else {',
    '  Write-Output "NOTFOUND"',
    '}',
  ].join('\n');
}
