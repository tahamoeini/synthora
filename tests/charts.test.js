import test from "node:test";
import assert from "node:assert/strict";
import {
  clampTooltipCenter,
  allocationBarChartMarkup,
  barChartMarkup,
  donutChartMarkup,
  lineChartMarkup,
  lineSegments,
  normalizeSeriesIndex,
} from "../src/ui/charts.js";

test("chart tooltip center stays within the chart at either edge", () => {
  assert.equal(clampTooltipCenter(4, 100, 260), 58);
  assert.equal(clampTooltipCenter(256, 100, 260), 202);
  assert.equal(clampTooltipCenter(130, 100, 260), 130);
  assert.equal(clampTooltipCenter(0, 300, 120), 60);
});

test("line chart data keeps missing market periods as visible gaps", () => {
  const segments = lineSegments([{ value: 10 }, { value: null }, { value: 20 }, { value: 30 }]);
  assert.equal(segments.length, 2);
  assert.deepEqual(
    segments[0].map((point) => point.value),
    [10],
  );
  assert.deepEqual(
    segments[1].map((point) => point.value),
    [20, 30],
  );
});

test("normalized comparison series uses the first observed value as index 100", () => {
  assert.deepEqual(
    normalizeSeriesIndex([{ value: 50 }, { value: 75 }, { value: null }]).map((point) => point.value),
    [100, 150, null],
  );
});

test("chart markup has explicit empty states and accessible SVG output", () => {
  assert.match(lineChartMarkup({ series: [{ name: "سبد", points: [{ value: 10 }] }] }), /داده کافی/);
  const markup = lineChartMarkup({
    ariaLabel: "سبد",
    series: [
      {
        name: "سبد",
        points: [
          { value: 10, label: "اول" },
          { value: 12, label: "دوم" },
        ],
      },
    ],
  });
  assert.match(markup, /role="group"/);
  assert.match(markup, /chart-line/);
  assert.match(markup, /chart-axis-label/);
  assert.match(markup, /chart-tooltip/);
  assert.match(markup, /tabindex="-1"/);
  assert.match(markup, /<title>سبد<\/title>/);
  assert.match(lineChartMarkup({ series: [{ points: [{ value: 10 }] }, { points: [{ value: 12 }] }] }), /داده کافی/);
  assert.match(
    lineChartMarkup({
      series: [{ points: [{ value: 10 }, { value: null }] }, { points: [{ value: 12 }, { value: null }] }],
    }),
    /داده کافی/,
  );
  assert.match(donutChartMarkup({ segments: [{ name: "طلا", value: 100, color: "#c18a2c" }] }), /donut-chart/);
  assert.match(donutChartMarkup({ segments: [] }), /هنوز دارایی/);
});

test("dated line charts position dots by observation dates and expose date values to assistive input", () => {
  const markup = lineChartMarkup({
    series: [
      {
        name: "طلا",
        points: [
          { date: "2026-01-01T00:00:00.000Z", label: "۱ فروردین", value: 100 },
          { date: "2026-01-02T00:00:00.000Z", label: "۲ فروردین", value: 101 },
          { date: "2026-01-10T00:00:00.000Z", label: "۱۰ فروردین", value: 102 },
        ],
      },
    ],
  });
  const coordinates = [...markup.matchAll(/<circle cx="([0-9.]+)"/g)].map((match) => Number(match[1]));
  assert.equal(coordinates.length, 3);
  assert.ok(coordinates[1] - coordinates[0] < coordinates[2] - coordinates[1]);
  assert.match(markup, /aria-label="طلا · ۱ فروردین · 100"/);
  assert.match(markup, /aria-keyshortcuts="ArrowLeft ArrowRight Home End"/);
});

test("long line charts summarize observations, cap interactive points, and offer a complete data table", () => {
  const points = Array.from({ length: 300 }, (_, index) => ({
    date: new Date(Date.UTC(2000, index, 1)).toISOString(),
    label: `Period ${index + 1}`,
    value: index,
  }));
  const markup = lineChartMarkup({
    ariaLabel: "Portfolio history",
    tableLabel: "Show chart data table",
    summaryLabels: {
      date: "Date",
      observations: "observations",
      first: "First",
      last: "Last",
      minimum: "Minimum",
      maximum: "Maximum",
      tableCaption: "Chart data",
    },
    series: [{ name: "Portfolio", points }],
  });
  assert.match(markup, /aria-describedby="line-chart-summary-/);
  assert.match(markup, /First: Period 1 0/);
  assert.match(markup, /Last: Period 300 299/);
  assert.equal([...markup.matchAll(/class="chart-dot"/g)].length, 60);
  assert.match(markup, /<details class="chart-data-details">/);
  assert.match(markup, /<summary>Show chart data table<\/summary>/);
  assert.match(markup, /Period 300/);
});

test("bar charts expose keyboard-focusable values and preserve a visible zero baseline", () => {
  const markup = barChartMarkup({
    ariaLabel: "Monthly contributions",
    items: [
      { label: "Jan", value: 0 },
      { label: "Feb", value: 40 },
    ],
    valueLabel: (value) => `$${value}`,
  });
  assert.match(markup, /class="chart-baseline"/);
  assert.match(markup, /class="chart-bar" tabindex="0"/);
  assert.match(markup, /aria-label="Feb · \$40"/);

  const comparison = allocationBarChartMarkup({
    items: [{ label: "Gold", actual: 60, target: 50 }],
    actualLabel: "Actual",
    targetLabel: "Target",
  });
  assert.match(comparison, /Gold/);
  assert.match(comparison, /Actual/);
  assert.match(comparison, /Target/);
  assert.match(comparison, /role="group"/);
  assert.match(allocationBarChartMarkup({ items: [] }), /No allocation data/);
});
