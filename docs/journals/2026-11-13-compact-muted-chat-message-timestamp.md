# Technical Journal: Compact Muted Message Timestamp in Chat Transcript

**Date:** 2026-11-13  
**Author:** Claude Code Engineer  
**Status:** Completed & Verified  

---

## 1. Problem Statement & Motivation

ClaudeCodeUI previously used `new Date(message.timestamp).toLocaleTimeString()` directly inside `MessageComponent.tsx`:
1. **Lacked Date Awareness:** It only displayed the time with seconds (dependent on the client system locale), with no distinction between messages sent today versus earlier dates.
2. **Crash Vulnerability:** Invalid timestamp inputs or raw epoch values could trigger unhandled `RangeError` exceptions during transcript rendering.
3. **Ergonomics & Visual Polish:** Timestamps lacked an unobtrusive, subtle aesthetic and did not provide high-resolution tooltips for auditing exact seconds.

---

## 2. Key Architectural Decisions & Implementation

### Phase 1: Pure Formatter Utilities with Defensive Coercion
- **Zero-Dependency Native Formatting:** Implemented `formatMessageTimestamp` and `formatFullTimestampTooltip` in `src/modules/chat/utils/chatFormatting.ts` using native JavaScript `Date` and `padStart(2, '0')`.
- **Calendar Boundary Comparison:** Compares local `getFullYear()`, `getMonth()`, and `getDate()` against `now`:
  - **Same Day:** Displays 24-hour time `HH:mm` (e.g. `14:30`, `09:05`).
  - **Different Day:** Displays full date and time `DD/MM/YYYY HH:mm` (e.g. `12/11/2026 14:30`).
- **Defensive Type Handling:** Validates non-empty input, coerces stringified epoch numbers (`/^\d+$/`), checks `Number.isNaN(date.getTime())`, and returns `''` gracefully on invalid inputs.
- **Microsecond-Precision Tooltip:** Provides a full `DD/MM/YYYY HH:mm:ss` timestamp in the native HTML `title` attribute without extra React DOM bloat.

### Phase 2: Transcript UI Integration & Style Harmonization
- **User Message Bubble:** Updated the timestamp element inside user message bubbles and attachment turns with Tailwind classes `select-none text-[10px] text-muted-foreground/70`, preserving user copy/fork/edit action buttons.
- **Assistant Response Footer:** Updated the assistant metadata footer with `select-none text-[10px] text-gray-400/80 dark:text-gray-500/80`.
- **Oxlint & Code Quality:** Followed Tailwind CSS class ordering conventions (`select-none` preceding text rules) and memoized both formatted values against `[message.timestamp]`.

---

## 3. Verification & Quality Gates

- **Unit Tests:** `src/modules/chat/tests/chatFormatting.test.ts` (9 tests passing) verifying same-day, cross-day, cross-year, string ISO, number, stringified epoch, invalid inputs, and tooltip format.
- **Chat Test Suite:** 64 test files passed (491 tests total across `src/modules/chat/`).
- **Typecheck:** `tsc --noEmit` passed cleanly with 0 errors.
- **Git Commit:** `a3709c8` with conventional commit format adhering to project commitlint rules.
