// Kijkt of src/openbolle.ts nog gelijk is aan de bron in sdk/typescript (werkt vanuit sjabloon/ en apps/).
import { readFileSync } from "node:fs";

const kopie = new URL("./src/openbolle.ts", import.meta.url);
const bron = new URL("../../sdk/typescript/src/openbolle.ts", import.meta.url);
let b;
try { b = readFileSync(bron, "utf8"); } catch {
  console.log("Bron niet gevonden (sdk/typescript/src/openbolle.ts); dit werkt alleen binnen openbolle-apps.");
  process.exit(0);
}
if (readFileSync(kopie, "utf8") === b) console.log("gelijk: src/openbolle.ts is dezelfde als de bron");
else {
  console.log("VERSCHIL: src/openbolle.ts is niet meer gelijk aan sdk/typescript/src/openbolle.ts. Kopieer de bron opnieuw.");
  process.exit(1);
}
