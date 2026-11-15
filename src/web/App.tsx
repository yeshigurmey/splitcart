import { useEffect, useState } from "react";
import { api, type Me } from "./api";
import { AuthPage } from "./AuthPage";
import { HomePage } from "./HomePage";
import { OrderPage } from "./OrderPage";

/**
 * Which page to show is kept in the part of the address after the "#":
 *   #/              the building's orders
 *   #/orders/<id>   one order
 * so links can be shared and the back button works, without a router library.
 */
function useRoute(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#/, "") || "/";
}

export function App() {
  // undefined: still asking the server who we are. null: nobody is logged in.
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const route = useRoute();

  useEffect(() => {
    // Any failure here (most often "not logged in") leads to the log-in page.
    api.me().then(setMe, () => setMe(null));
  }, []);

  if (me === undefined) return <p className="loading">Loading…</p>;
  if (me === null) return <AuthPage onDone={setMe} />;

  async function logout() {
    await api.logout().catch(() => undefined);
    window.location.hash = "/";
    setMe(null);
  }

  const orderId = /^\/orders\/([^/]+)$/.exec(route)?.[1];

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          SplitCart
        </a>
        <div className="topbar-right">
          <span className="who">{me.user.name}</span>
          <button className="link" onClick={logout}>
            Log out
          </button>
        </div>
      </header>
      <main>{orderId ? <OrderPage key={orderId} orderId={orderId} /> : <HomePage me={me} />}</main>
    </div>
  );
}
