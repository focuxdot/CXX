import assert from "node:assert/strict";
import test from "node:test";

import { bmpFromMatrix, qrMatrix } from "../daemon/src/qr-bmp.mjs";

test("QR BMP has a valid 24-bit square BMP header", () => {
  const matrix = qrMatrix("https://focuxdot.github.io/CXX/#d=" + "A".repeat(220), "M");
  assert.ok(matrix.length >= 33);
  const bmp = bmpFromMatrix(matrix, { quiet: 4, targetPx: 480 });
  assert.equal(bmp.toString("ascii", 0, 2), "BM");
  const width = bmp.readInt32LE(18);
  const height = bmp.readInt32LE(22);
  assert.equal(width, height);
  assert.equal(bmp.readUInt16LE(28), 24);
});
