import { useEffect, useRef, useState } from "react";

// A recording run's screen as it happens: a fresh picture from src twice a second (its live.jpg, or what a plugin
// serves for a simulator), cropped to where anything has been on it (the device in the middle of the screen), and
// only ever grown so the view holds still. Used on a run's page and on the canvas.
export function LiveView({ src, className = "", tall = "max-h-[70vh]" }: { src: string; className?: string; tall?: string }) {
  const view = useRef<HTMLCanvasElement>(null);
  const box = useRef<{ x0: number; y0: number; x1: number; y1: number } | undefined>(undefined);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    const scan = document.createElement("canvas");
    const next = () => {
      const img = new Image();
      img.onload = () => {
        if (!on) return;
        // where anything's been on the screen, looked for on a small copy
        const k = 8;
        scan.width = Math.ceil(img.width / k);
        scan.height = Math.ceil(img.height / k);
        const sc = scan.getContext("2d", { willReadFrequently: true })!;
        sc.drawImage(img, 0, 0, scan.width, scan.height);
        const px = sc.getImageData(0, 0, scan.width, scan.height).data;
        for (let y = 0; y < scan.height; y++)
          for (let x = 0; x < scan.width; x++) {
            const i = (y * scan.width + x) * 4;
            if (px[i] + px[i + 1] + px[i + 2] < 36) continue;
            const b = box.current;
            box.current = b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
          }
        const b = box.current;
        const [sx, sy] = b ? [b.x0 * k, b.y0 * k] : [0, 0];
        const [sw, sh] = b ? [Math.min(img.width, (b.x1 + 1) * k) - sx, Math.min(img.height, (b.y1 + 1) * k) - sy] : [img.width, img.height];
        const c = view.current;
        if (c) {
          c.width = sw;
          c.height = sh;
          c.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
          setShown(true);
        }
        timer = setTimeout(next, 500);
      };
      img.onerror = () => on && (timer = setTimeout(next, 1000));
      img.src = `${src}${src.includes("?") ? "&" : "?"}t=${Date.now()}`;
    };
    next();
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [src]);
  return (
    <div className={`bg-black overflow-hidden ${className}`}>
      <canvas ref={view} className={`w-full h-auto ${tall} object-contain block mx-auto ${shown ? "" : "hidden"}`} aria-label="The screen as it's being recorded" />
      {!shown && <div className="h-[240px] grid place-items-center text-muted text-[13px]">Waiting for the screen</div>}
    </div>
  );
}
