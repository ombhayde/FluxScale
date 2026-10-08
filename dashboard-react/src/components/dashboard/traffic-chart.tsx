import { useId, useMemo, useState } from "react";
import { curveMonotoneX } from "@visx/curve";
import { GridRows } from "@visx/grid";
import { scaleLinear, scaleTime } from "@visx/scale";
import { AreaClosed, LinePath } from "@visx/shape";
import { motion } from "motion/react";

import type { TrafficPoint } from "@/lib/api";

interface TrafficChartProps {
  data: TrafficPoint[];
  loading?: boolean;
}

const WIDTH = 900;
const HEIGHT = 330;

const MARGIN = {
  top: 26,
  right: 24,
  bottom: 44,
  left: 62,
};

function formatTraffic(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatTime(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

export function TrafficChart({
  data,
  loading = false,
}: TrafficChartProps) {
  const generatedId = useId().replaceAll(":", "");
  const gradientId = `fluxscale-area-${generatedId}`;

  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const points = useMemo(
    () =>
      [...data].sort(
        (first, second) =>
          new Date(first.timestamp).getTime() -
          new Date(second.timestamp).getTime(),
      ),
    [data],
  );

  const innerWidth = WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  const firstTimestamp =
    points.length > 0
      ? new Date(points[0].timestamp).getTime()
      : 0;

  const lastTimestamp =
    points.length > 0
      ? new Date(points[points.length - 1].timestamp).getTime()
      : 60_000;

  const xDomainStart =
    firstTimestamp === lastTimestamp
      ? firstTimestamp - 30_000
      : firstTimestamp;

  const xDomainEnd =
    firstTimestamp === lastTimestamp
      ? lastTimestamp + 30_000
      : lastTimestamp;

  const maximumValue = Math.max(
    100,
    ...points.flatMap((point) => [
      point.actual ?? 0,
      point.predicted ?? 0,
      point.capacity ?? 0,
    ]),
  );

  const xScale = scaleTime({
    domain: [new Date(xDomainStart), new Date(xDomainEnd)],
    range: [0, innerWidth],
  });

  const yScale = scaleLinear<number>({
    domain: [0, maximumValue * 1.12],
    range: [innerHeight, 0],
    nice: true,
  });

  const actualPoints = points.filter(
    (point) => point.actual !== null,
  );

  const predictedPoints = points.filter(
    (point) => point.predicted !== null,
  );

  const activePoint =
    activeIndex === null ? undefined : points[activeIndex];

  const activeValue =
    activePoint?.actual ?? activePoint?.predicted ?? 0;

  if (!loading && points.length === 0) {
    return (
      <div className="flex h-[330px] flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-black/10 text-center">
        <div className="mb-3 size-2 rounded-full bg-violet-400 shadow-[0_0_20px_rgba(167,139,250,0.9)]" />

        <p className="text-sm font-medium text-foreground">
          Waiting for telemetry
        </p>

        <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
          Send metric samples to FluxScale and the live traffic forecast
          will appear here.
        </p>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="relative overflow-hidden rounded-xl border border-white/5 bg-black/10"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-violet-500/5 to-transparent" />

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Actual traffic, predicted traffic, and service capacity"
        className="relative block h-auto w-full"
      >
        <defs>
          <linearGradient
            id={gradientId}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop
              offset="0%"
              stopColor="rgb(139 92 246)"
              stopOpacity="0.42"
            />
            <stop
              offset="75%"
              stopColor="rgb(59 130 246)"
              stopOpacity="0.08"
            />
            <stop
              offset="100%"
              stopColor="rgb(59 130 246)"
              stopOpacity="0"
            />
          </linearGradient>
        </defs>

        <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            height={innerHeight}
            numTicks={5}
            stroke="rgba(255,255,255,0.08)"
            strokeDasharray="4 6"
          />

          {yScale.ticks(5).map((tick) => (
            <text
              key={tick}
              x={-14}
              y={yScale(tick)}
              dy="0.32em"
              textAnchor="end"
              fill="rgba(255,255,255,0.38)"
              fontSize={11}
            >
              {formatTraffic(tick)}
            </text>
          ))}

          {xScale.ticks(5).map((tick) => (
            <text
              key={tick.getTime()}
              x={xScale(tick)}
              y={innerHeight + 28}
              textAnchor="middle"
              fill="rgba(255,255,255,0.38)"
              fontSize={11}
            >
              {formatTime(tick)}
            </text>
          ))}

          {actualPoints.length > 1 && (
            <>
              <AreaClosed<TrafficPoint>
                data={actualPoints}
                x={(point) =>
                  xScale(new Date(point.timestamp))
                }
                y={(point) => yScale(point.actual ?? 0)}
                yScale={yScale}
                curve={curveMonotoneX}
                fill={`url(#${gradientId})`}
              />

              <LinePath<TrafficPoint>
                data={actualPoints}
                x={(point) =>
                  xScale(new Date(point.timestamp))
                }
                y={(point) => yScale(point.actual ?? 0)}
                curve={curveMonotoneX}
                stroke="rgb(139 92 246)"
                strokeWidth={3}
                strokeLinecap="round"
              />
            </>
          )}

          {predictedPoints.length > 1 && (
            <LinePath<TrafficPoint>
              data={predictedPoints}
              x={(point) =>
                xScale(new Date(point.timestamp))
              }
              y={(point) => yScale(point.predicted ?? 0)}
              curve={curveMonotoneX}
              stroke="rgb(34 211 238)"
              strokeWidth={3}
              strokeDasharray="8 7"
              strokeLinecap="round"
            />
          )}

          {points.length > 1 && (
            <LinePath<TrafficPoint>
              data={points}
              x={(point) =>
                xScale(new Date(point.timestamp))
              }
              defined={(point) => point.capacity !== null}
              y={(point) => yScale(point.capacity ?? 0)}
              curve={curveMonotoneX}
              stroke="rgba(251,191,36,0.75)"
              strokeWidth={1.5}
              strokeDasharray="3 7"
            />
          )}

          {activePoint && (
            <>
              <line
                x1={xScale(new Date(activePoint.timestamp))}
                x2={xScale(new Date(activePoint.timestamp))}
                y1={0}
                y2={innerHeight}
                stroke="rgba(255,255,255,0.3)"
                strokeDasharray="3 4"
              />

              <circle
                cx={xScale(new Date(activePoint.timestamp))}
                cy={yScale(activeValue)}
                r={5}
                fill="rgb(15 23 42)"
                stroke="rgb(167 139 250)"
                strokeWidth={3}
              />

              <g
                transform={`translate(${Math.min(
                  Math.max(
                    xScale(new Date(activePoint.timestamp)) + 12,
                    0,
                  ),
                  innerWidth - 162,
                )}, 12)`}
              >
                <rect
                  width={162}
                  height={82}
                  rx={10}
                  fill="rgba(9,9,15,0.94)"
                  stroke="rgba(255,255,255,0.12)"
                />

                <text
                  x={12}
                  y={20}
                  fill="rgba(255,255,255,0.55)"
                  fontSize={10}
                >
                  {formatTime(new Date(activePoint.timestamp))}
                </text>

                <text
                  x={12}
                  y={42}
                  fill="rgb(196 181 253)"
                  fontSize={12}
                  fontWeight={600}
                >
                  Actual:{" "}
                  {activePoint.actual === null
                    ? "—"
                    : `${formatTraffic(activePoint.actual)} RPS`}
                </text>

                <text
                  x={12}
                  y={61}
                  fill="rgb(103 232 249)"
                  fontSize={12}
                  fontWeight={600}
                >
                  Predicted:{" "}
                  {activePoint.predicted === null
                    ? "—"
                    : `${formatTraffic(activePoint.predicted)} RPS`}
                </text>

                <text
                  x={12}
                  y={77}
                  fill="rgb(252 211 77)"
                  fontSize={10}
                >
                  Estimated capacity: {activePoint.capacity === null ? "Unknown" : `${formatTraffic(activePoint.capacity)} RPS`}
                </text>
              </g>
            </>
          )}

          <rect
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onPointerMove={(event) => {
              const bounds =
                event.currentTarget.getBoundingClientRect();

              const pointerX =
                ((event.clientX - bounds.left) / bounds.width) *
                innerWidth;

              const targetTime = xScale.invert(pointerX).getTime();

              const nearestIndex = points.reduce(
                (bestIndex, point, index) => {
                  const currentDistance = Math.abs(
                    new Date(point.timestamp).getTime() - targetTime,
                  );

                  const bestDistance = Math.abs(
                    new Date(
                      points[bestIndex].timestamp,
                    ).getTime() - targetTime,
                  );

                  return currentDistance < bestDistance
                    ? index
                    : bestIndex;
                },
                0,
              );

              setActiveIndex(nearestIndex);
            }}
            onPointerLeave={() => setActiveIndex(null)}
          />
        </g>
      </svg>

      <div className="flex flex-wrap items-center gap-5 border-t border-white/5 px-5 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="h-0.5 w-6 rounded bg-violet-500" />
          Actual traffic
        </span>

        <span className="flex items-center gap-2">
          <span className="w-6 border-t-2 border-dashed border-cyan-400" />
          Predicted traffic
        </span>

        <span className="flex items-center gap-2">
          <span className="w-6 border-t border-dashed border-amber-400" />
          Replica capacity
        </span>
      </div>
    </motion.div>
  );
}
