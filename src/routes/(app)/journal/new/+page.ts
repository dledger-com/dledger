// Demo-mode route guard. /journal/new is the only entry-creation/edit
// surface in dledger; in the read-only demo we redirect away from it
// before the page component mounts.
import { redirect } from "@sveltejs/kit";
import { DEMO_MODE } from "$lib/demo.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = () => {
  if (DEMO_MODE) throw redirect(307, "/journal");
};
