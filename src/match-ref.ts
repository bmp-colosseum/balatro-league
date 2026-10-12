// Short, phone-friendly reference for a match/pairing cuid. The full id is a
// 26-char cuid -- the longest line in every match embed and result post on a
// phone. The last 6 characters, uppercased, read as a short code ("A1B2C3")
// instead. Not a lookup key: it is a human reference for players to quote in
// a "Report a problem" ticket, not a unique search key -- staff still look up
// the full id (DB primary key, admin web URLs) unchanged.
export function matchRef(id: string): string {
  return id.slice(-6).toUpperCase();
}
