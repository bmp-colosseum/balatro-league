// Shared result shape for admin server actions that report back to the UI via a
// flash banner (see ActionFlashForm). `null` = no result yet (initial render).
export type ActionResult = { ok: boolean; message: string } | null;
