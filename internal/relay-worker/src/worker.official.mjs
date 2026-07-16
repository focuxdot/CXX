// Internal official relay entrypoint.
// This layers operator-only stats/notifications onto the public zero-knowledge relay core.

import { BaseRelayRoom, createRelayWorker } from "../../../relay/worker/src/relay-core.mjs";
import { createStatsHooks, handleStats } from "./stats.mjs";

const hooks = createStatsHooks({ productLabel: "cxx" });

export default createRelayWorker({
  serviceLabel: "wokey relay",
  handleRequest(_request, env, _ctx, url) {
    if (url.pathname === "/admin/stats") return handleStats(env, url);
    return null;
  },
});

export class RelayRoom extends BaseRelayRoom {
  constructor(state, env) {
    super(state, env, { hooks });
  }
}
