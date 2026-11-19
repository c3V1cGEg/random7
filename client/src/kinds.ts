import type { AnnotationKind, ChangeStatus } from "../../server/types.ts";

/** Display metadata for mark kinds. Colour comes from the `kind-*` CSS classes. */
export const KIND_META: Record<AnnotationKind | "none", { icon: string; label: string }> = {
  none: { icon: "#", label: "Note" },
  question: { icon: "?", label: "Question" },
  incorrect: { icon: "✗", label: "Wrong" },
  "needs-testing": { icon: "✓", label: "Test" },
  attention: { icon: "!", label: "Attention" },
  suggestion: { icon: "+", label: "Idea" },
  decision: { icon: "◆", label: "Decision" },
  uncertain: { icon: "~", label: "Unsure" },
  custom: { icon: "•", label: "Custom" },
};

/** Kinds offered as one-click chips on the selection bar (the rest stay in the mark card). */
export const QUICK_KINDS: Array<AnnotationKind | undefined> = [undefined, "question", "incorrect", "needs-testing", "attention", "suggestion", "decision"];

/** Proposal statuses (colour from the `status-*` CSS classes); unmarked elements are "existing". */
export const STATUS_META: Record<ChangeStatus, { label: string; hint: string }> = {
  new: { label: "New", hint: "Added by this proposal" },
  changed: { label: "Changed", hint: "Exists today; its behaviour changes (details inside)" },
  removed: { label: "Removed", hint: "Exists today; this proposal drops it" },
};
