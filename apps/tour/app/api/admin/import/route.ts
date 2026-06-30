// REST trigger for the all-xlsx import (the same logic the admin upload uses).
//   POST /api/admin/import   → import every season from the TT*.xlsx in TOUR_SHEETS_DIR
import { NextResponse } from "next/server";
import { isApiAdmin } from "@/lib/auth";
import { importAllFromXlsx } from "@/lib/services/import";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!(await isApiAdmin(req))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const result = await importAllFromXlsx();
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
