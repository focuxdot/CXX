// 会话按项目（cwd）聚合——codex / claude 两个后端共用。
//
// normSep 必须与 web/index.html 里的同名函数逐字一致：daemon 用它建 idToCwd/分组键，
// web 用它建 projByCwd 并按 cwd 匹配看板增量。两边分歧会把同一项目拆成两组或错配徽标。
export function normSep(cwd) {
  return (cwd || "").trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

// threads（backend.listThreads 产物：含 id/cwd/updatedAt/name/preview）→ 按 cwd 分组。
// 返回 { projects, idToCwd, hasMore }；projects 按最近活跃时间新→旧，preview 截到 previewMax。
// 只做「分组 + 取每组最近一条的展示信息」，不含运行/审批徽标——那些由 hub 实时叠加。
export function groupProjects(threads, { cap = 800, previewMax = 80 } = {}) {
  const byCwd = new Map(); // normCwd -> entry
  const idToCwd = new Map(); // threadId -> normCwd
  for (const t of threads) {
    if (!t?.id) continue;
    const norm = normSep(t.cwd);
    idToCwd.set(t.id, norm);
    let e = byCwd.get(norm);
    if (!e) {
      e = { norm, cwd: t.cwd || "", count: 0, latestUpdatedAt: 0, latestName: null, latestPreview: "" };
      byCwd.set(norm, e);
    }
    e.count++;
    if ((t.updatedAt || 0) >= e.latestUpdatedAt) {
      e.latestUpdatedAt = t.updatedAt || 0;
      e.latestName = t.name ?? null;
      e.latestPreview = t.preview ? String(t.preview).slice(0, previewMax) : "";
      e.cwd = t.cwd || e.cwd; // 展示用最近会话的原始 cwd
    }
  }
  const all = [...byCwd.values()].sort((a, b) => (b.latestUpdatedAt || 0) - (a.latestUpdatedAt || 0));
  return { projects: all.slice(0, cap), idToCwd, hasMore: all.length > cap };
}

// TTL + 单飞缓存：包住「一次全量本地扫描 + 分组」。scan() 返回 threads 数组。
// 首页 projects.list 命中缓存即 0 扫描；新建会话可 invalidate 立即重建。运行/审批徽标
// 不进缓存（每次实时从 hub 叠加），故看板变化无需失效——只有会话集合变了才需要。
export class CachedProjects {
  #scan;
  #ttl;
  #builtAt = 0;
  #value = null;
  #building = null;
  constructor(scan, { ttlMs = 10000 } = {}) {
    this.#scan = scan;
    this.#ttl = ttlMs;
  }
  invalidate() {
    this.#builtAt = 0;
  }
  async get() {
    const now = Date.now();
    if (this.#value && now - this.#builtAt < this.#ttl) return this.#value;
    if (this.#building) return this.#building; // 单飞：并发请求共享同一次扫描，不重复拉全量
    this.#building = (async () => {
      try {
        const threads = await this.#scan();
        this.#value = groupProjects(threads);
        this.#builtAt = Date.now();
        return this.#value;
      } finally {
        this.#building = null;
      }
    })();
    return this.#building;
  }
}
