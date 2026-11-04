"use client";

import { useEffect, useState } from "react";
import { savedUrl } from "@/lib/overlay-build";

// An overlay page opened without its ?key=: most likely refreshed by hand after the page took
// the key out of the address bar (VideoOverlay). Go back to the link this tab first opened,
// key and all; where there's none, say what's wrong instead of a bare 404.
export default function OverlayKeyRecover() {
  const [lost, setLost] = useState(false);
  useEffect(() => {
    const to = savedUrl();
    if (to) window.location.replace(to);
    else setLost(true);
  }, []);
  if (!lost) return null;
  return (
    <div style={{ fontFamily: "sans-serif", color: "#fff", background: "rgba(0,0,0,0.7)", padding: "12px 16px", display: "inline-block", fontSize: 18 }}>
      This overlay link is missing its key. Copy the link again from the bot page and paste it into the browser source.
    </div>
  );
}
