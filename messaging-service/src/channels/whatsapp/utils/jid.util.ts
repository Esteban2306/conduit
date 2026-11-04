/**
 * Utilidades de JID de WhatsApp (solo texto, sin depender de Baileys).
 *
 * WhatsApp identifica a un usuario por teléfono (`573001234567@s.whatsapp.net`)
 * o, cada vez más, por un LID anónimo (`123456789012345@lid`) que NO es un
 * número telefónico. Confundirlos hace que se responda a un número
 * inexistente o que el backend busque al cliente por un teléfono falso.
 */

const PN_SUFFIX = '@s.whatsapp.net';
const LID_SUFFIX = '@lid';

/** Grupos, difusiones/estados y canales: el bot nunca debe procesarlos. */
export function isIgnorableJid(jid: string | null | undefined): boolean {
  if (!jid) return true;
  return (
    jid.endsWith('@g.us') ||
    jid.endsWith('@broadcast') ||
    jid.endsWith('@newsletter')
  );
}

export function isPhoneJid(jid: string | null | undefined): jid is string {
  return !!jid && jid.endsWith(PN_SUFFIX);
}

export function isLidJid(jid: string | null | undefined): jid is string {
  return !!jid && jid.endsWith(LID_SUFFIX);
}

/** Usuario del JID sin dominio ni dispositivo: "57300…:12@s.whatsapp.net" → "57300…". */
export function jidUser(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/** Dirección LID canónica ("123…@lid"), usada cuando no se conoce el teléfono. */
export function lidAddress(jid: string): string {
  return `${jidUser(jid)}${LID_SUFFIX}`;
}

export function isLidAddress(address: string): boolean {
  return /^\d+@lid$/.test(address);
}

export function phoneToJid(digits: string): string {
  return `${digits}${PN_SUFFIX}`;
}

/**
 * Dirección con la que se identifica la conversación: el teléfono (solo
 * dígitos) si se conoce, o la dirección LID si WhatsApp no lo reveló.
 */
export function conversationAddress(jid: string): string {
  return isLidJid(jid) ? lidAddress(jid) : jidUser(jid);
}
