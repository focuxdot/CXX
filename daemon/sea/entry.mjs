// SEA 打包入口：显式运行 daemon CLI。
// 置哨兵后 main.mjs 的 isDirectRun 自动运行分支不再触发，避免 bundle 中重复执行。
globalThis.__CXX_ENTRY__ = true;
import { main } from "../src/main.mjs";

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
