// Next-Auth v5 dynamic route handler. Handles /api/auth/* requests including
// OAuth callback, sign-in, sign-out, session.
import { handlers } from "@/auth";
export const { GET, POST } = handlers;
