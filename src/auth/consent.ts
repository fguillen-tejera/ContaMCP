import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { CONSENT_REMEMBER_DAYS } from './approvals';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function consentPage(
  details: ConsentDescription,
  handle: string,
  nonce: string,
  english: boolean,
) {
  const text = (es: string, en: string) => (english ? en : es);
  const ledger = details.scope.includes('ledger:read');
  const manageLedger = details.scope.includes('ledger:write');
  const manageExpenses = details.scope.includes('expenses:write');
  const access = manageLedger
    ? text(
        'Podrá consultar y administrar tus registros financieros.',
        'It can read and manage your financial records.',
      )
    : ledger && manageExpenses
      ? text(
          'Podrá consultar tus finanzas y administrar tus gastos.',
          'It can read your finances and manage your expenses.',
        )
      : manageExpenses
        ? text('Podrá consultar y administrar tus gastos.', 'It can read and manage your expenses.')
        : ledger
          ? text(
              'Podrá consultar tus registros financieros.',
              'It can read your financial records.',
            )
          : text('Podrá consultar tus gastos.', 'It can read your expenses.');
  return `<!doctype html><html lang="${english ? 'en' : 'es-MX'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${text('Conectar con ContaMCP', 'Connect to ContaMCP')}</title>
<style nonce="${escapeHtml(nonce)}">
:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif;color:#152c27;background:#f2f6f3}*{box-sizing:border-box}body{margin:0;padding:24px 16px}main{max-width:480px;margin:48px auto;background:#fff;border:1px solid #d3dfd7;border-radius:18px;padding:32px}h1{font-size:1.75rem;line-height:1.2;margin:20px 0 16px}h1,p,strong{overflow-wrap:anywhere}.brand{color:#236548;font-weight:750;letter-spacing:.04em}.access{margin:24px 0;padding:16px;background:#f2f6f3;border-radius:10px}.access p{margin:0}.muted,small{color:#475d54}.actions{display:grid;gap:8px;margin-top:24px}button{font:inherit;min-height:48px;border:1px solid #176448;border-radius:9px;padding:10px 20px;cursor:pointer;background:#176448;color:#fff;font-weight:650}.secondary{background:transparent;color:#17523c;border-color:transparent}button:focus-visible{outline:3px solid #226bd1;outline-offset:4px}small{display:block;font-size:.8rem;margin-top:20px}small p{margin:6px 0}@media(max-width:420px){main{margin:0 auto;padding:24px}}@media(prefers-color-scheme:dark){:root{color:#e4efe8;background:#101b17}main{background:#192821;border-color:#3b5044}.brand{color:#91d5af}.muted,small{color:#bfd0c5}.access{background:#23392d}.secondary{color:#b2e4c7;background:transparent;border-color:transparent}button{background:#1e7855;border-color:#72bb94}}
</style></head><body><main><div class="brand">ContaMCP</div><h1>${text('Conecta tus finanzas', 'Connect your finances')}</h1>
<p>${text('Usa tu cuenta de Google para conectar ContaMCP con', 'Use your Google account to connect ContaMCP to')} <strong>${escapeHtml(details.clientName)}</strong>.</p>
<div class="access"><p>${access}</p></div>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><div class="actions"><button name="decision" value="approve">${text('Conectar con Google', 'Connect with Google')}</button><button class="secondary" name="decision" value="deny">${text('Cancelar', 'Cancel')}</button></div></form>
<small><p>${text(`Recordaremos esta conexión durante ${CONSENT_REMEMBER_DAYS} días en este navegador.`, `We will remember this connection for ${CONSENT_REMEMBER_DAYS} days in this browser.`)}</p><p>${text('Volverás a', 'You will return to')} <strong>${escapeHtml(details.redirectHost)}</strong>.</p><p>${details.clientDomain ? `${text('Aplicación publicada por', 'App published by')} ${escapeHtml(details.clientDomain)}.` : text('Nombre proporcionado por la aplicación.', 'App name supplied by the application.')}</p>${details.redirectIsLoopback ? `<p>${text('Conecta una aplicación de tu equipo. Continúa si tú iniciaste la conexión.', 'This connects an app on your computer. Continue if you started the connection.')}</p>` : ''}<p>${text('No conectamos tu banco ni movemos dinero.', 'We do not connect to your bank or move money.')}</p></small></main></body></html>`;
}

export function validScopeDependencies(scopes: readonly string[]) {
  return ['ledger', 'expenses'].every(
    (family) => !scopes.includes(`${family}:write`) || scopes.includes(`${family}:read`),
  );
}
