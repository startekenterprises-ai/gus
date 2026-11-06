/**
 * The GUS product version — single source of truth.
 *
 * This constant is what the runtime reports in its comm `hello`, what
 * the control plane reports in its `welcome`, and what the Updater
 * (Phase 3) compares release manifests against. A release bundle is
 * this tree, packed; the Phase 3 release fixture produces the next
 * version by patching the packed copy of this constant (and the
 * bundle's VERSION file, which scripts/pack.mjs derives from here) —
 * never by editing a running install.
 */
export const GUS_VERSION = "0.4.1";
