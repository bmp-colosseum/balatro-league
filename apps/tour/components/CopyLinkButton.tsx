"use client";

// Copies an absolute app URL to the clipboard (for pasting an /overlay/... link into an OBS
// browser source). Builds the absolute URL from window.location.origin at click time - there's no
// tour self-URL env var, and this works on every deploy. Shows a brief "Copied!" flash.
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyLinkButton({ path, label = "Copy overlay link" }: { path: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / denied) - no-op; the link is still visible on hover.
    }
  };
  return (
    <Button type="button" variant="secondary" size="sm" onClick={onClick} title={path}>
      {copied ? "Copied!" : label}
    </Button>
  );
}
