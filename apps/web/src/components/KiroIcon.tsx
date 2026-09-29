/**
 * Kiro provider icon.
 *
 * Deliberately a NEW file rather than an addition to `components/Icons.tsx`:
 * this fork carries the Kiro provider as a local addition, and every upstream
 * file it leaves untouched is one fewer rebase conflict. The settings registry
 * imports this directly.
 *
 * The mark is an original geometric glyph — a bracket pair around a cursor
 * caret — rather than a reproduction of any vendor logo, which would be both a
 * trademark question and misleading about who ships the binary.
 *
 * @module components/KiroIcon
 */
import type { Icon } from "./Icons";

export const KiroIcon: Icon = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    {/* Left bracket */}
    <path d="M8.5 4.5 5 8v8l3.5 3.5" />
    {/* Right bracket */}
    <path d="M15.5 4.5 19 8v8l-3.5 3.5" />
    {/* Caret: the agent's insertion point between them */}
    <path d="M12 9v6" />
    <path d="M10.4 10.6 12 9l1.6 1.6" />
  </svg>
);
