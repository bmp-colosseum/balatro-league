// Render one tile from a Balatro sprite atlas via CSS background-position.
// Ported from the Antelytics viewer's Sprite component. Pure render (no client
// JS) so it works as a server component. Atlas art is extracted from Balatro
// game files; see public/balatro/atlases/ATTRIBUTION.md.
//
// Usage: <Sprite id="j_blueprint" height={48} />
//   id = key in lib/sprite-registry.json (e.g. "j_pizza", "v_retcon", "c_hex").

import registryJson from "@/lib/sprite-registry.json";

interface RegistryEntry {
  atlas: string;
  name: string;
  set: string;
  x: number;
  y: number;
}
const registry = registryJson as Record<string, RegistryEntry>;

// Atlas grid metadata (tile size + columns/rows). Only the atlases vendored
// into public/balatro/atlases are listed; ids on other atlases render blank.
const ATLAS_META: Record<string, { tileW: number; tileH: number; cols: number; rows: number }> = {
  "Jokers.png": { tileW: 142, tileH: 190, cols: 10, rows: 16 },
  "Tarots.png": { tileW: 142, tileH: 190, cols: 10, rows: 6 },
  "Vouchers.png": { tileW: 142, tileH: 190, cols: 9, rows: 4 },
  // Individual single-tile multiplayer sprites.
  "j_pizza.png": { tileW: 142, tileH: 190, cols: 1, rows: 1 },
  "j_conjoined_joker.png": { tileW: 142, tileH: 190, cols: 1, rows: 1 },
  "j_defensive_joker.png": { tileW: 142, tileH: 190, cols: 1, rows: 1 },
  "j_pacifist.png": { tileW: 142, tileH: 190, cols: 1, rows: 1 },
  "j_taxes.png": { tileW: 142, tileH: 190, cols: 1, rows: 1 },
  "j_skip_off.png": { tileW: 142, tileH: 190, cols: 1, rows: 1 },
  "j_penny_pincher.png": { tileW: 142, tileH: 190, cols: 1, rows: 1 },
  "j_speedrun.png": { tileW: 142, tileH: 190, cols: 1, rows: 1 },
  "j_lets_go_gambling.png": { tileW: 142, tileH: 190, cols: 1, rows: 1 },
  "c_asteroid.png": { tileW: 142, tileH: 190, cols: 1, rows: 1 },
  "c_ouija_2.png": { tileW: 142, tileH: 190, cols: 1, rows: 1 },
};
const DEFAULT_META = ATLAS_META["Jokers.png"]!;

// Registry/meta keep ".png" names; the shipped sheets are lossless WebP.
const atlasUrl = (name: string) => `/balatro/atlases/${name.replace(/\.png$/i, ".webp")}`;

export function Sprite({
  id,
  height = 48,
  className = "",
  title,
}: {
  id: string;
  height?: number;
  className?: string;
  title?: string;
}) {
  const entry = registry[id];
  if (!entry) {
    return (
      <span
        className={className}
        title={`Missing sprite: ${id}`}
        aria-label={id}
        style={{
          display: "inline-block",
          width: height * 0.75,
          height,
          borderRadius: 4,
          border: "1px dashed var(--border)",
          opacity: 0.4,
        }}
      />
    );
  }

  const meta = ATLAS_META[entry.atlas] ?? DEFAULT_META;
  const aspect = meta.tileW / meta.tileH;
  const h = `${height}px`;
  const style = {
    "--sprite-h": h,
    display: "inline-block",
    backgroundRepeat: "no-repeat",
    imageRendering: "auto",
    backgroundImage: `url(${atlasUrl(entry.atlas)})`,
    backgroundPosition: `calc(${-entry.x} * var(--sprite-h) * ${aspect}) calc(${-entry.y} * var(--sprite-h))`,
    backgroundSize: `calc(${meta.cols} * var(--sprite-h) * ${aspect}) calc(${meta.rows} * var(--sprite-h))`,
    width: `calc(var(--sprite-h) * ${aspect})`,
    height: "var(--sprite-h)",
    verticalAlign: "middle",
    flexShrink: 0,
  } as React.CSSProperties;

  return (
    <span className={className} role="img" aria-label={title ?? entry.name} title={title ?? entry.name} style={style} />
  );
}
