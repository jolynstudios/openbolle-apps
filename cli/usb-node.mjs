// `dev --bolle`: de seriële poort van Bolle in Node, zonder extra pakketten (macOS en Linux; Windows: gebruik de knop
// "Verbind je Bolle" op de pagina, die werkt met Web Serial in Chrome of Edge).
import { execFileSync } from "node:child_process";
import { closeSync, createReadStream, openSync, readdirSync, writeSync } from "node:fs";
import { BolleUsb } from "./bolle-usb.mjs";

export function zoekPoort() {
  const kandidaten = readdirSync("/dev").filter((n) => /^cu\.usbmodem|^ttyACM/.test(n)).sort();
  return kandidaten.length ? "/dev/" + kandidaten[0] : null;
}

/** Opent de poort en geeft een BolleUsb terug, plus stop(). */
export function openBolle(poort, { log } = {}) {
  if (process.platform === "win32") throw new Error("--bolle werkt op macOS en Linux; gebruik op Windows de knop op de pagina (Web Serial)");
  execFileSync("stty", [process.platform === "darwin" ? "-f" : "-F", poort, "115200", "raw", "-echo", "-hupcl"], { stdio: "ignore" });
  const fd = openSync(poort, "r+");
  const usb = new BolleUsb((regel) => writeSync(fd, regel + "\n"), { log });
  let rest = "";
  const lees = createReadStream(null, { fd, autoClose: false, highWaterMark: 4096 });
  lees.on("data", (d) => {
    rest += d.toString("latin1");
    let i;
    while ((i = rest.indexOf("\n")) >= 0) { usb.regel(Buffer.from(rest.slice(0, i), "latin1").toString("utf8")); rest = rest.slice(i + 1); }
  });
  lees.on("error", (e) => usb.op.fout?.(e));
  lees.on("end", () => usb.op.fout?.(new Error("de verbinding met Bolle is weg")));
  return { usb, poort, stop: () => { lees.destroy(); try { closeSync(fd); } catch { /* al dicht */ } } };
}

/* PNG zonder pakketten, voor /api/bolle/scherm */
import { deflateSync } from "node:zlib";
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function stuk(type, data) {
  const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4);
  l.writeUInt32BE(data.length); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([l, t, data, c]);
}
export function png({ breed, hoog, rgba }) {
  const rauw = Buffer.alloc((breed * 4 + 1) * hoog);
  for (let y = 0; y < hoog; y++) { rauw[y * (breed * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * breed * 4, breed * 4).copy(rauw, y * (breed * 4 + 1) + 1); }
  const kop = Buffer.alloc(13); kop.writeUInt32BE(breed, 0); kop.writeUInt32BE(hoog, 4); kop[8] = 8; kop[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), stuk("IHDR", kop), stuk("IDAT", deflateSync(rauw)), stuk("IEND", Buffer.alloc(0))]);
}
