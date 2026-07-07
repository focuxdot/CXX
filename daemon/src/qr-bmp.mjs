// QR code -> BMP (24-bit uncompressed, white background, black modules).
//
// Windows tray uses WinForms PictureBox, which can read BMP without additional
// encoders. Keeping QR rendering in the daemon leaves the tray as a thin view.
import { writeFileSync } from "node:fs";
import qrcode from "./vendor/qrcode.cjs";

export function qrMatrix(text, ecc = "M") {
  const qr = qrcode(0, ecc);
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = new Array(n);
    for (let c = 0; c < n; c++) row[c] = qr.isDark(r, c) ? 1 : 0;
    rows.push(row);
  }
  return rows;
}

export function bmpFromMatrix(matrix, { quiet = 4, targetPx = 480 } = {}) {
  const n = matrix.length;
  const total = n + quiet * 2;
  const scale = Math.max(3, Math.floor(targetPx / total));
  const dim = total * scale;

  const rowBytes = dim * 3;
  const pad = (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + pad;
  const pixels = Buffer.alloc(stride * dim, 0xff);

  for (let mr = 0; mr < n; mr++) {
    for (let mc = 0; mc < n; mc++) {
      if (matrix[mr][mc] !== 1) continue;
      const x0 = (mc + quiet) * scale;
      const y0 = (mr + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const bmpRow = dim - 1 - (y0 + dy);
        let off = bmpRow * stride + x0 * 3;
        for (let dx = 0; dx < scale; dx++) {
          pixels[off] = 0;
          pixels[off + 1] = 0;
          pixels[off + 2] = 0;
          off += 3;
        }
      }
    }
  }

  const fileHeader = Buffer.alloc(14);
  fileHeader.write("BM", 0, "ascii");
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(dim, 4);
  dib.writeInt32LE(dim, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(24, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(pixels.length, 20);
  dib.writeInt32LE(2835, 24);
  dib.writeInt32LE(2835, 28);
  const fileSize = 14 + 40 + pixels.length;
  fileHeader.writeUInt32LE(fileSize, 2);
  fileHeader.writeUInt32LE(54, 10);
  return Buffer.concat([fileHeader, dib, pixels]);
}

export function writeQrBmp(text, filePath, opts = {}) {
  writeFileSync(filePath, bmpFromMatrix(qrMatrix(text, opts.ecc), opts));
  return filePath;
}
