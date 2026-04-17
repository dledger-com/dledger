import type { QifProfileExtension } from "../types.js";
import { wiseQifProfile } from "../../qif/profiles/wise.js";

export const builtinQifProfiles: QifProfileExtension[] = [
  wiseQifProfile,
];
