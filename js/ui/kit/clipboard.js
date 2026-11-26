// Área de transferência (genérico, sem regra de negócio).

/** Copia texto para a área de transferência (API moderna; senão, textarea + execCommand). */
export async function copyToClipboard(text, win = globalThis) {
  const nav = win.navigator;
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(text);
      return true;
    } catch {
      // cai para o método antigo
    }
  }
  try {
    const doc = win.document;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand('copy');
    area.remove();
    return !!ok;
  } catch {
    return false;
  }
}
