// xlsx → positional cell grid (matching sheet.mjs's HTML output: rows of trimmed
// cell strings, empties preserved so columns line up). Lets the season parsers walk
// xlsx tabs the same way they walked the HTML exports. Handles merged cells,
// formula results, rich text, and hyperlinks.
import ExcelJS from "exceljs";

// One cell → its display string.
export function cellText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text ?? "").join("").trim();
    if (v.text != null) return String(v.text).trim(); // hyperlink
    if (v.result != null) return cellText(v.result); // formula → result
    if (v.formula != null) return ""; // formula with no cached result
    if (v.error != null) return "";
  }
  return "";
}

// Read one worksheet → 2D array of cell strings (1-based columns flattened, empties
// kept). `maxCols` caps very wide sheets.
export function gridOf(ws, maxCols = 200) {
  const rows = [];
  const cols = Math.min(ws.columnCount || 0, maxCols);
  for (let r = 1; r <= (ws.rowCount || 0); r++) {
    const row = ws.getRow(r);
    const cells = [];
    for (let c = 1; c <= cols; c++) cells.push(cellText(row.getCell(c).value));
    rows.push(cells);
  }
  return rows;
}

// Load a workbook + return a tab's grid by name (case-insensitive, trims). null if absent.
export async function readXlsxTab(path, tabName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return tabGrid(wb, tabName);
}

export function tabGrid(wb, tabName) {
  const want = tabName.toLowerCase().trim();
  const ws = wb.worksheets.find((w) => w.name.toLowerCase().trim() === want);
  return ws ? gridOf(ws) : null;
}

export async function loadWorkbook(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

export const tabNames = (wb) => wb.worksheets.map((w) => w.name);
