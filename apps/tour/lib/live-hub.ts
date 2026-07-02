// In-process fan-out for live refresh (C5). ONE pg LISTEN connection per web instance
// (not per subscriber — connection budget) on channel "tour_live"; each SSE subscriber
// registers a scope string and gets pinged when a NOTIFY with that payload arrives.
// Cached on globalThis so dev HMR doesn't leak connections.
import { Client } from "pg";

type Sub = { scope: string; send: (data: string) => void };

class LiveHub {
  private subs = new Set<Sub>();
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;

  private async ensure(): Promise<void> {
    if (this.client) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const c = new Client({ connectionString: process.env.DATABASE_URL });
        await c.connect();
        await c.query("LISTEN tour_live");
        c.on("notification", (msg) => {
          const scope = msg.payload ?? "";
          for (const s of this.subs) if (s.scope === scope) s.send(scope);
        });
        // On connection loss, drop the client so the next subscriber reconnects.
        c.on("error", () => {
          this.client = null;
          this.connecting = null;
        });
        this.client = c;
      })().catch((e) => {
        this.connecting = null;
        throw e;
      });
    }
    await this.connecting;
  }

  async subscribe(scope: string, send: (data: string) => void): Promise<() => void> {
    await this.ensure();
    const sub: Sub = { scope, send };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }
}

const g = globalThis as { __tourLiveHub?: LiveHub };
export const liveHub: LiveHub = (g.__tourLiveHub ??= new LiveHub());
