// Thin CLI wrapper over the all-xlsx import SERVICE (logic lives in
// lib/services/import.ts). Reads the TT*.xlsx from TOUR_SHEETS_DIR / TOUR_XLSX_DIR.
//   npm run import
import { importAllFromXlsx } from "../lib/services/import";

importAllFromXlsx()
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
