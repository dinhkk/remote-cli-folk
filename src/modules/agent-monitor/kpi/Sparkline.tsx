type SparklineProps = {
  /** Oldest first; a null (not measured) repeats the last known value so the line has no hole. */
  values: Array<number | null>;
  /** Drawn from zero up to the largest value, or to this when it is larger (a CPU line should not blow a flat 0.1% up to full height). */
  minimumMax?: number;
  className?: string;
  label: string;
};

const WIDTH = 100;
const HEIGHT = 24;

/**
 * A 60-second line chart with no axes: just the shape of the recent past. Drawn as one SVG polyline (no chart library),
 * the area under it filled lightly. Used by the KPI cards and the resource rows.
 */
export function Sparkline({ values, minimumMax = 1, className, label }: SparklineProps) {
  const filled: number[] = [];
  let last = 0;
  for (const value of values) {
    last = value ?? last;
    filled.push(last);
  }

  if (filled.length < 2) {
    return <svg role="img" aria-label={label} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className={className} preserveAspectRatio="none" />;
  }

  const max = Math.max(minimumMax, ...filled);
  const points = filled.map((value, index) => {
    const x = (index / (filled.length - 1)) * WIDTH;
    const y = HEIGHT - 1 - (value / max) * (HEIGHT - 3);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className={className} preserveAspectRatio="none">
      <polygon points={`0,${HEIGHT} ${points.join(' ')} ${WIDTH},${HEIGHT}`} className="fill-primary/10" />
      <polyline points={points.join(' ')} fill="none" className="stroke-primary" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
