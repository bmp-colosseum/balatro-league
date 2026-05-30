import express, { type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import { env } from "../env.js";
import { adminAuthCheck, authRouter } from "./auth.js";
import { playerRouter } from "./player-routes.js";
import { publicRouter } from "./public-routes.js";
import { router } from "./routes.js";

export function startAdminServer(): void {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.set("trust proxy", 1);

  app.use(
    session({
      name: "bl.sid",
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
        // secure: true once we're on HTTPS in production
      },
    }),
  );

  // Public routes (no login required) — must come BEFORE the admin auth middleware
  app.use(publicRouter);

  // Auth routes (login, callback, logout)
  app.use("/auth", authRouter);

  // Player-facing routes (require login)
  app.use(playerRouter);

  // Admin routes: support EITHER basic-auth password OR OAuth + ADMIN tier
  app.use("/admin", async (req: Request, res: Response, next: NextFunction) => {
    // Try basic auth first (legacy / no-OAuth admins)
    if (env.ADMIN_DASH_PASSWORD) {
      const header = req.headers.authorization ?? "";
      const [scheme, encoded] = header.split(" ");
      if (scheme === "Basic" && encoded) {
        const [, pass] = Buffer.from(encoded, "base64").toString().split(":");
        if (pass === env.ADMIN_DASH_PASSWORD) {
          (req as { _basicAuthOk?: boolean })._basicAuthOk = true;
          return next();
        }
      }
    }

    // Try OAuth
    if (await adminAuthCheck(req)) return next();

    // Neither worked. If neither auth method is configured, allow (localhost dev).
    if (!env.ADMIN_DASH_PASSWORD && !env.DISCORD_CLIENT_SECRET) {
      return next();
    }

    // Not logged in via Discord → send them to log in (stash return path)
    if (env.DISCORD_CLIENT_SECRET && !req.session.user) {
      (req.session as { returnTo?: string }).returnTo = req.originalUrl;
      return res.redirect("/auth/discord/login");
    }

    // Password-only mode (no OAuth, has password, no valid creds yet)
    if (env.ADMIN_DASH_PASSWORD && !req.session.user) {
      return res
        .set("WWW-Authenticate", 'Basic realm="Balatro Admin", charset="UTF-8"')
        .status(401)
        .send(`Authentication required.`);
    }

    // Logged in via Discord but doesn't have ADMIN tier
    const u = req.session.user!;
    return res.status(403).send(
      `<!doctype html><meta charset="utf-8"><title>Forbidden</title>` +
        `<body style="font-family:sans-serif; max-width:600px; margin:60px auto; padding:0 20px; color:#e6e8ec; background:#0f1115">` +
        `<h1>🚫 Forbidden</h1>` +
        `<p>You're logged in as <strong>${u.username}</strong>, but your Discord account doesn't have the <strong>ADMIN</strong> tier needed to manage the league.</p>` +
        `<p>An owner can grant you access with <code>/league set-role tier:ADMIN role:@YourRole</code> in Discord.</p>` +
        `<p><a style="color:#5865f2" href="/me">Go to your profile</a> · <a style="color:#5865f2" href="/standings">Public standings</a> · <a style="color:#5865f2" href="/auth/logout">Log out</a></p>` +
        `</body>`,
    );
  });
  app.use("/admin", router);

  // Root: send authenticated users to /me, otherwise to /admin (or login)
  app.get("/", (req, res) => {
    if (req.session.user) return res.redirect("/me");
    res.redirect("/admin");
  });

  const port = env.PORT ?? env.WEB_PORT;
  app.listen(port, () => {
    const authNote =
      env.DISCORD_CLIENT_SECRET
        ? "(Discord OAuth enabled)"
        : env.ADMIN_DASH_PASSWORD
          ? "(password auth)"
          : "(no auth — localhost only please)";
    console.log(`Admin dashboard on http://localhost:${port}/admin ${authNote}`);
    if (env.DISCORD_CLIENT_SECRET) {
      console.log(`Player login at http://localhost:${port}/auth/discord/login`);
    }
  });
}
