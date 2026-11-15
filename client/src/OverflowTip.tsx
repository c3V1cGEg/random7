import { useEffect, useState } from "react";

/**
 * One tooltip for the whole editor, showing the full text of anything that is cut off:
 * elements with class `clip` (shown when their content overflows) and elements with
 * `data-tip` (a shortened label carrying its full text). Never the browser's title tooltip.
 */
export function OverflowTip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tip], .clip") ?? null;
      if (el === current) return;
      hide();
      current = el;
      if (!el || el.querySelector(".label-edit")) return;
      timer = setTimeout(() => {
        const full = el.dataset.tip ?? el.innerText;
        const clipped = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
        const shortened = el.dataset.tip !== undefined && el.dataset.tip.trim() !== el.innerText.trim();
        if (!full.trim() || (!clipped && !shortened)) return;
        const r = el.getBoundingClientRect();
        const above = r.bottom + 140 > innerHeight;
        setTip({ text: full, x: Math.min(Math.max(r.left + r.width / 2, 190), innerWidth - 190), y: above ? r.top - 6 : r.bottom + 6, above });
      }, 280);
    };
    document.addEventListener("pointerover", over);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("keydown", hide);
    return () => {
      document.removeEventListener("pointerover", over);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("wheel", hide);
      window.removeEventListener("keydown", hide);
      clearTimeout(timer);
    };
  }, []);

  if (!tip) return null;
  return (
    <div className={`overflow-tip${tip.above ? " above" : ""}`} role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>
  );
}
