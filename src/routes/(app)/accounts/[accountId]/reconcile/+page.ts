// Demo-mode route guard. Reconciliation is a mutation flow; in the
// read-only demo we redirect back to the account detail page.
import { redirect } from "@sveltejs/kit";
import { DEMO_MODE } from "$lib/demo.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = ({ params }) => {
  if (DEMO_MODE) throw redirect(307, `/accounts/${params.accountId}`);
};
