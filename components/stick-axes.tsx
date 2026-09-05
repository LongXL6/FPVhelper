export function StickAxes({ xLabel, yLabel }: { xLabel: string; yLabel: string }) {
  return (
    <span className="stick-axes" aria-hidden="true">
      <span className="axis axis-x" />
      <span className="axis axis-y" />
      <small className="stick-tick stick-tick--left">−1000</small>
      <small className="stick-tick stick-tick--right">+1000</small>
      <small className="stick-tick stick-tick--top">+1000</small>
      <small className="stick-tick stick-tick--bottom">−1000</small>
      <small className="stick-tick stick-tick--zero">0</small>
      <small className="axis-label axis-label-x">{xLabel}</small>
      <small className="axis-label axis-label-y">{yLabel}</small>
    </span>
  );
}
