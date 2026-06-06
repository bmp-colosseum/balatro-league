// Map a canonical deck/stake name to its image filename slug, matching the
// PNGs in web/public/balatro/{decks,stakes}/. Mirrors deckSlug/stakeSlug in
// the bot's src/balatro-info.ts so the web can render the same art.

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function deckImage(name: string): string {
  return `/balatro/decks/${slug(name)}.png`;
}

export function stakeImage(name: string): string {
  return `/balatro/stakes/${slug(name)}.png`;
}
