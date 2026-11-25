/**
 * The ring that marks the focused box of the graph. Drawn just outside the box (it is a child of the box's button, which does
 * not clip), so it never changes the layout. `radius` is the box's own corner radius in px; the ring sits 3 px outside it.
 */
export function FocusRing({ radius }: { radius: number }) {
  return (
    <span
      aria-hidden="true"
      data-focus-ring="true"
      className="pointer-events-none absolute -inset-[3px] border-[2.5px] border-primary"
      style={{ borderRadius: radius + 3 }}
    />
  );
}
