// Pick a free localhost port for the app-server to listen on.
//
// The default 19271 is frequently already taken: the OFFICIAL Codex `remote-control` /
// app-server daemon binds it too. We spawn our OWN app-server and must not fight the
// official one for the port — so we probe the preferred port and fall back to an
// OS-assigned ephemeral port if it's busy. Since the daemon controls both ends (it
// launches app-server and connects to it), any free port works.
import { createServer } from "node:net";

// Is `port` bindable on 127.0.0.1 right now?
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

// Ask the OS for a free ephemeral port.
function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Resolve the port to actually use: the preferred one if free, otherwise an ephemeral
// port. Returns { port, fallback } where fallback is true if we had to move off preferred.
export async function resolveAppServerPort(preferred) {
  if (preferred && (await isPortFree(preferred))) {
    return { port: preferred, fallback: false };
  }
  return { port: await ephemeralPort(), fallback: true };
}
