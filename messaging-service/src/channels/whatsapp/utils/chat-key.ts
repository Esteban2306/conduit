import { conversationAddress } from './jid.util';

export const CHAT_KEY_SEPARATOR = '|';

export function chatKey(connectionId: string, jid: string): string {
  return `${connectionId}${CHAT_KEY_SEPARATOR}${conversationAddress(jid)}`;
}

export function chatKeyPrefix(connectionId: string): string {
  return `${connectionId}${CHAT_KEY_SEPARATOR}`;
}
