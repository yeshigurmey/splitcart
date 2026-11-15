/**
 * Starts the server. All configuration comes from environment variables:
 *
 *   PORT               port to listen on (default 3000)
 *   DATABASE_PATH      SQLite file (default ./data/splitcart.db)
 *   STRIPE_SECRET_KEY  a Stripe test mode key (sk_test_...). Without one the
 *                      app uses the built-in fake payment provider.
 *   NODE_ENV           "production" serves the built web app from ./dist and
 *                      marks the session cookie HTTPS-only
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app";
import { openDb } from "./db";
import { FakeGateway, type PaymentGateway } from "./payments";
import { Service } from "./service";
import { StripeGateway } from "./stripe";

const port = Number(process.env.PORT ?? 3000);
const databasePath = process.env.DATABASE_PATH ?? "./data/splitcart.db";
const production = process.env.NODE_ENV === "production";

mkdirSync(path.dirname(databasePath), { recursive: true });

const stripeKey = process.env.STRIPE_SECRET_KEY;
const gateway: PaymentGateway = stripeKey ? new StripeGateway(stripeKey) : new FakeGateway();

const service = new Service({ db: openDb(databasePath), gateway });
const app = createApp(service, {
  staticDir: production ? path.resolve("dist") : undefined,
  secureCookies: production,
});

app.listen(port, () => {
  console.log(`SplitCart API listening on http://localhost:${port}`);
  console.log(
    stripeKey
      ? "Payments: Stripe test mode."
      : "Payments: built-in fake provider (set STRIPE_SECRET_KEY to use Stripe test mode).",
  );
});
