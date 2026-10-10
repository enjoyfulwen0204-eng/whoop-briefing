/** Immediate sendMessage only. Scheduled/ephemeral ID zero is not delivery
 * evidence. Validate raw Bot API types before any conversion or settlement.
 * Reference: https://core.telegram.org/bots/api#message */
export const validMessageId = id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validImmediateMessage(message, chatId) {
 return object(message) && validMessageId(message.message_id)
  && typeof message.date === 'number' && Number.isSafeInteger(message.date) && message.date > 0
  && object(message.chat) && typeof message.chat.id === 'number' && Number.isSafeInteger(message.chat.id) && message.chat.id !== 0
  && ['private','group','supergroup','channel'].includes(message.chat.type)
  && (chatId === undefined || String(message.chat.id) === String(chatId));
}
export const validApiSuccess = value => object(value) && value.ok === true && Object.hasOwn(value,'result');
