export function loginPage(origin: string, emailSignIn: boolean, english: boolean, nonce: string) {
  const text = (es: string, en: string) => (english ? en : es);
  const endpoint = `${origin}/mcp`.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const instructions = emailSignIn
    ? text(
        'Al conectar, continúa con Google o usa una cuenta de correo y contraseña creada por el operador.',
        'When connecting, continue with Google or use an email/password account provisioned by the operator.',
      )
    : text(
        'Al conectar, continúa con tu cuenta de Google.',
        'When connecting, continue with Google.',
      );
  return `<!doctype html><html lang="${english ? 'en' : 'es-MX'}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${text('Iniciar sesión en ContaMCP', 'Sign in to ContaMCP')}</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif;background:#f2f6f3;color:#152c27}*{box-sizing:border-box}body{margin:0;padding:24px 16px}main{max-width:520px;margin:40px auto;padding:28px;border:1px solid #d3dfd7;border-radius:18px;background:#fff}h1{color:#236548;font-size:1rem}h2{font-size:1.6rem;line-height:1.25}code{overflow-wrap:anywhere}@media(prefers-color-scheme:dark){:root{background:#101b17;color:#e4efe8}main{background:#192821;border-color:#3b5044}h1{color:#91d5af}}
</style></head><body><main><h1>ContaMCP</h1>
<h2>${text('Inicia la conexión en tu asistente', 'Start the connection in your assistant')}</h2>
<p>${text('Agrega esta dirección en ChatGPT u otro cliente MCP compatible con OAuth:', 'Add this server address in ChatGPT or another OAuth-capable MCP client:')}</p>
<p><code>${endpoint}</code></p><p>${instructions}</p>
${emailSignIn ? `<p>${text('Si ya usas Google, continúa con Google para conservar tu registro. Las cuentas de correo tienen un registro separado.', 'Existing Google users should continue with Google to keep their ledger. Email accounts have a separate ledger.')}</p>` : ''}
<p>${text('Iniciamos sesión dentro de la conexión de tu asistente para que autorices sus permisos y dirección de regreso.', 'Sign-in takes place within your assistant connection so you can authorize its permissions and return address.')}</p>
</main></body></html>`;
}
