<script setup lang="ts">
import { computed, useId } from 'vue';

const props = withDefaults(
  defineProps<{
    values: (number | null)[];
    /** 第二条曲线（例如网络上行），不传则只画一条。 */
    values2?: (number | null)[];
    /** 固定窗口长度，保证数值少时从左侧开始生长。 */
    capacity?: number;
    max?: number;
    color?: string;
    color2?: string;
    height?: number;
  }>(),
  { capacity: 60, max: 100, color: '#3b82f6', color2: '#22c55e', height: 46 },
);

const WIDTH = 200;
const uid = useId();
const suffix = computed(() => uid.replace(/[^a-zA-Z0-9_-]/g, ''));
const gradientId = computed(() => `perf-fill-${suffix.value}`);
const gradientId2 = computed(() => `perf-fill-${suffix.value}-2`);

const height = computed(() => props.height);
const max = computed(() => (props.max > 0 ? props.max : 100));
const capacity = computed(() => Math.max(2, props.capacity));

function buildSegments(values: (number | null)[] | undefined) {
  if (!values) return [];
  const points: { x: number; y: number | null }[] = values.map(
    (value, index) => ({
      x: (index / (capacity.value - 1)) * WIDTH,
      y:
        value === null || !Number.isFinite(value)
          ? null
          : height.value -
            (Math.min(Math.max(value, 0), max.value) / max.value) * height.value,
    }),
  );

  const groups: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  for (const point of points) {
    if (point.y === null) {
      if (current.length > 0) groups.push(current);
      current = [];
      continue;
    }
    current.push({ x: point.x, y: point.y });
  }
  if (current.length > 0) groups.push(current);

  return groups
    .filter((group) => group.length > 0)
    .map((group) => {
      const line = group
        .map(
          (point, index) =>
            `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
        )
        .join(' ');
      const first = group[0]!;
      const last = group[group.length - 1]!;
      const area =
        group.length > 1
          ? `${line} L ${last.x.toFixed(2)} ${height.value} L ${first.x.toFixed(2)} ${height.value} Z`
          : '';
      return { line, area, last };
    });
}

const segments = computed(() => buildSegments(props.values));
const segments2 = computed(() => buildSegments(props.values2));

const gridLines = computed(() =>
  [0.25, 0.5, 0.75].map((ratio) => height.value * ratio),
);

const hasData = computed(() =>
  [...props.values, ...(props.values2 ?? [])].some(
    (value) => value !== null && Number.isFinite(value),
  ),
);
</script>

<template>
  <svg
    class="sparkline"
    :viewBox="`0 0 ${WIDTH} ${height}`"
    preserveAspectRatio="none"
    role="img"
    aria-hidden="true"
  >
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" :stop-color="color" stop-opacity="0.26" />
        <stop offset="100%" :stop-color="color" stop-opacity="0.02" />
      </linearGradient>
      <linearGradient :id="gradientId2" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" :stop-color="color2" stop-opacity="0.2" />
        <stop offset="100%" :stop-color="color2" stop-opacity="0.02" />
      </linearGradient>
    </defs>

    <line
      v-for="(y, index) in gridLines"
      :key="index"
      class="grid"
      x1="0"
      :y1="y"
      :x2="WIDTH"
      :y2="y"
    />

    <g v-for="(segment, index) in segments" :key="index">
      <path
        v-if="segment.area"
        :d="segment.area"
        :fill="`url(#${gradientId})`"
        stroke="none"
      />
      <path
        :d="segment.line"
        fill="none"
        :stroke="color"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
      <circle
        :cx="segment.last.x"
        :cy="segment.last.y"
        r="2.4"
        :fill="color"
        vector-effect="non-scaling-stroke"
      />
    </g>

    <g v-for="(segment, index) in segments2" :key="`second-${index}`">
      <path
        v-if="segment.area"
        :d="segment.area"
        :fill="`url(#${gradientId2})`"
        stroke="none"
      />
      <path
        :d="segment.line"
        fill="none"
        :stroke="color2"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-dasharray="4 3"
        vector-effect="non-scaling-stroke"
      />
      <circle
        :cx="segment.last.x"
        :cy="segment.last.y"
        r="2.2"
        :fill="color2"
        vector-effect="non-scaling-stroke"
      />
    </g>

    <text v-if="!hasData" class="empty" x="100" y="25" text-anchor="middle">
      等待采样
    </text>
  </svg>
</template>

<style scoped>
.sparkline {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.grid {
  stroke: rgba(15, 23, 42, 0.07);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.empty {
  fill: var(--text-faint, #a1a1aa);
  font-size: 10px;
}
</style>
