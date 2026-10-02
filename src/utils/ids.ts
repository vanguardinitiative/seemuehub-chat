/**
 * Ids the way Mongo and clients hand them over: a string, an ObjectId (any
 * bson copy), a populated document (`{ _id, … }`), or nothing.
 */

/** A 24-hex ObjectId string; anything else (another type, a 12-byte string) is not. */
export const isObjectIdString = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value);

/** An id as a string; null when there is none. */
export const idString = (value: unknown, depth = 0): string | null => {
  if (value === null || value === undefined || depth > 2) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value !== "object") return null;
  // An ObjectId. Checked before `_id`: mongoose gives ObjectId a `_id` getter
  // that returns the ObjectId itself.
  const hex = (value as { toHexString?: unknown }).toHexString;
  if (typeof hex === "function") return String(hex.call(value));
  return idString((value as { _id?: unknown })._id, depth + 1);
};
