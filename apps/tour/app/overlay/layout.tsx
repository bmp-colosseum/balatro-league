// Chromeless layout for stream overlays (OBS browser sources). The root layout renders the
// site header for every route, so this scoped style strips it + makes the page transparent —
// only the widget shows over the stream.
export default function OverlayLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        header { display: none !important; }
        html, body { background: transparent !important; }
        main { max-width: none !important; padding: 0 !important; margin: 0 !important; }
      `}</style>
      <div style={{ padding: 8 }}>{children}</div>
    </>
  );
}
