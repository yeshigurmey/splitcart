/**
 * The HTTP layer: turns web requests into calls on the Service and the
 * results back into JSON. No rules live here. If a request is not allowed,
 * the Service or the order rules throw, and the error handler at the bottom
 * picks the status code.
 *
 *   POST   /api/signup  /api/login  /api/logout      GET /api/me
 *   GET    /api/orders                               POST /api/orders
 *   GET    /api/orders/:id
 *   POST   /api/orders/:id/join   /leave
 *   POST   /api/orders/:id/items                     DELETE /api/orders/:id/items/:itemId
 *   POST   /api/orders/:id/lock   /unlock  /place  /deliver  /cancel
 *   POST   /api/orders/:id/hold
 *   GET    /api/orders/:id/events                    live updates for one order
 *   GET    /api/events                               live updates for the order list
 */

import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { OrderError, TRANSITIONS, type OrderAction } from "../order";
import { buildingTopic, orderTopic } from "./events";
import { AppError, type Service, type User } from "./service";

const COOKIE = "splitcart_session";
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const HEARTBEAT_MS = 25_000;

export interface AppOptions {
  /** Folder holding the built web app (the output of `npm run build`), if it should be served. */
  staticDir?: string;
  /** Send the session cookie over HTTPS only. Turn on in production. */
  secureCookies?: boolean;
}

export function createApp(service: Service, options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20kb" }));

  // ----- sessions -------------------------------------------------------------

  function sessionToken(req: Request): string | undefined {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name === COOKIE) return value.join("=");
    }
    return undefined;
  }

  /**
   * The session lives in a cookie the browser sends by itself.
   *   HttpOnly       JavaScript on the page cannot read it, so a script
   *                  injected into the page cannot steal the login
   *   SameSite=Lax   other websites cannot make the browser send it with a
   *                  POST, which blocks cross-site request forgery
   */
  function setSession(res: Response, token: string, maxAgeSeconds: number): void {
    const secure = options.secureCookies ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`,
    );
  }

  function requireUser(req: Request): User {
    const user = service.userForToken(sessionToken(req));
    if (!user) throw new AppError(401, "not_logged_in", "Please log in.");
    return user;
  }

  const me = (user: User) => ({ user, building: service.building(user.buildingId) });
  const orderId = (req: Request) => String(req.params.id);

  // ----- accounts -------------------------------------------------------------

  app.post("/api/signup", (req, res) => {
    const { user, token } = service.signup(req.body ?? {});
    setSession(res, token, THIRTY_DAYS_SECONDS);
    res.status(201).json(me(user));
  });

  app.post("/api/login", (req, res) => {
    const { user, token } = service.login(req.body ?? {});
    setSession(res, token, THIRTY_DAYS_SECONDS);
    res.json(me(user));
  });

  app.post("/api/logout", (req, res) => {
    const token = sessionToken(req);
    if (token) service.logout(token);
    setSession(res, "", 0);
    res.json({ ok: true });
  });

  app.get("/api/me", (req, res) => {
    res.json(me(requireUser(req)));
  });

  // ----- orders ---------------------------------------------------------------

  app.get("/api/orders", (req, res) => {
    res.json(service.listOrders(requireUser(req)));
  });

  app.post("/api/orders", (req, res) => {
    res.status(201).json(service.createOrder(requireUser(req), req.body ?? {}));
  });

  app.get("/api/orders/:id", (req, res) => {
    res.json(service.getOrder(requireUser(req), orderId(req)));
  });

  app.post("/api/orders/:id/join", async (req, res) => {
    res.json(await service.join(requireUser(req), orderId(req)));
  });

  app.post("/api/orders/:id/leave", async (req, res) => {
    res.json(await service.leave(requireUser(req), orderId(req)));
  });

  app.post("/api/orders/:id/items", async (req, res) => {
    res.status(201).json(await service.addItem(requireUser(req), orderId(req), req.body ?? {}));
  });

  app.delete("/api/orders/:id/items/:itemId", async (req, res) => {
    res.json(await service.removeItem(requireUser(req), orderId(req), String(req.params.itemId)));
  });

  app.post("/api/orders/:id/hold", async (req, res) => {
    res.json(await service.hold(requireUser(req), orderId(req), req.body?.paymentMethod));
  });

  // One route per state machine action: lock, unlock, place, deliver, cancel.
  for (const action of Object.keys(TRANSITIONS) as OrderAction[]) {
    app.post(`/api/orders/:id/${action}`, async (req, res) => {
      res.json(await service.act(requireUser(req), orderId(req), action));
    });
  }

  // ----- live updates ---------------------------------------------------------

  /**
   * Server-sent events: the browser opens this URL once and the response
   * never ends. Whenever the topic is published, `snapshot()` is sent down
   * the open connection as one more message. It is one-way (server to
   * browser), which is all a live view needs, and it is plain HTTP.
   */
  function stream(req: Request, res: Response, topic: string, snapshot: () => unknown): void {
    const first = snapshot(); // throws (for example 404) before any headers are sent
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // ask proxies not to hold messages back
    });

    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send(first);

    const stop = service.events.subscribe(topic, () => {
      try {
        send(snapshot());
      } catch {
        res.end(); // the viewer can no longer see this, for example after logging out
      }
    });
    // A comment line now and then keeps idle connections from being closed.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);

    res.on("close", () => {
      stop();
      clearInterval(heartbeat);
    });
  }

  app.get("/api/orders/:id/events", (req, res) => {
    const token = sessionToken(req);
    const id = orderId(req);
    // The user is looked up again for every message, so logging out ends the stream.
    stream(req, res, orderTopic(id), () => {
      const user = service.userForToken(token);
      if (!user) throw new AppError(401, "not_logged_in", "Please log in.");
      return service.getOrder(user, id);
    });
  });

  app.get("/api/events", (req, res) => {
    const token = sessionToken(req);
    const { buildingId } = requireUser(req);
    stream(req, res, buildingTopic(buildingId), () => {
      const user = service.userForToken(token);
      if (!user) throw new AppError(401, "not_logged_in", "Please log in.");
      return service.listOrders(user);
    });
  });

  // ----- everything else --------------------------------------------------------

  app.use("/api", (_req, _res) => {
    throw new AppError(404, "not_found", "No such API route.");
  });

  // In production the same server also hands out the built web app.
  if (options.staticDir && existsSync(options.staticDir)) {
    const index = path.resolve(options.staticDir, "index.html");
    app.use(express.static(options.staticDir));
    app.use((req, res, next) => (req.method === "GET" ? res.sendFile(index) : next()));
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const reply = (status: number, code: string, message: string) => {
      if (res.headersSent) return res.end();
      res.status(status).json({ error: { code, message } });
    };

    if (error instanceof AppError) return reply(error.status, error.code, error.message);
    if (error instanceof OrderError) {
      // 403: you are not allowed to. 409: nobody could right now, given the order's state.
      const forbidden = error.code === "not_member" || error.code === "not_host";
      return reply(forbidden ? 403 : 409, error.code, error.message);
    }
    if (isBodyError(error)) return reply(400, "invalid", "The request body is not valid JSON.");

    console.error(error);
    reply(500, "server_error", "Something went wrong on our side.");
  });

  return app;
}

/** express.json() failed to read the body (broken JSON, or too large). */
function isBodyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const type = (error as { type?: unknown }).type;
  return type === "entity.parse.failed" || type === "entity.too.large";
}
