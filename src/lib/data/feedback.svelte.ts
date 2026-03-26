// Shared state for opening the feedback wizard from anywhere.

let _open = $state(false);
let _initialStep = $state<string | null>(null);

export const feedbackWizard = {
  get open() { return _open; },
  set open(v: boolean) { _open = v; },
  get initialStep() { return _initialStep; },
  set initialStep(v: string | null) { _initialStep = v; },

  /** Open the wizard directly to the "missing source" step. */
  openMissingSource() {
    _initialStep = "source-type";
    _open = true;
  },

  /** Open the wizard to the default step. */
  openDefault() {
    _initialStep = null;
    _open = true;
  },
};
