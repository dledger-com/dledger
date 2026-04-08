// Demo-mode route guard. The Sources page is entirely about
// configuring data import flows (blockchain addresses, CEX API keys,
// file imports). None of that applies to a read-only demo.
import { redirect } from "@sveltejs/kit";
import { DEMO_MODE } from "$lib/demo.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = () => {
  if (DEMO_MODE) throw redirect(307, "/");
};
