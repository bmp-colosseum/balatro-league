// SSE live-refresh stream (C5). A browser subscribes to a scope ("draft:<seasonId>",
// "matchup:<matchupId>", "sets"); when a service NOTIFYs that scope, the client gets an
// event and refreshes its server-rendered page. Public read — the event carries no data
// beyond "something changed" (the page re-render enforces all visibility rules).
import { liveHub } from "@/lib/live-hub";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  const scope = decodeURIComponent(channel);
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          /* stream already closed */
        }
      };
      try {
        cleanup = await liveHub.subscribe(scope, send);
      } catch {
        // LISTEN connection unavailable — degrade to a silent stream (page still works).
      }
      send("hello");
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          /* closed */
        }
      }, 15_000);
      req.signal.addEventListener("abort", () => {
        cleanup?.();
        if (keepAlive) clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup?.();
      if (keepAlive) clearInterval(keepAlive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
