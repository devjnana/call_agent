/** Minimal structured logging without external deps */
const PREFIX = '[engine]';

export const log = {
  info: (...a) => console.log(PREFIX, ...a),
  warn: (...a) => console.warn(PREFIX, ...a),
  error: (...a) => console.error(PREFIX, ...a),
};
