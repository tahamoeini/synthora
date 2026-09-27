// @ts-check

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function lineSegments(points) {
  const segments = [];
  let current = [];
  (Array.isArray(points) ? points : []).forEach((point) => {
    const value = finite(point && point.value);
    if (value === null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push({ ...point, value });
  });
  if (current.length) segments.push(current);
  return segments;
}

function pathFor(points, x, y) {
  return points
    .map((point, index) => `${index ? "L" : "M"}${x(point).toFixed(2)},${y(point.value).toFixed(2)}`)
    .join(" ");
}

function defaultValueLabel(value) {
  return String(Math.round(Number(value) || 0));
}

export function clampTooltipCenter(center, tooltipWidth, chartWidth, padding = 8) {
  const safeChartWidth = Math.max(0, Number(chartWidth) || 0);
  const safePadding = Math.max(0, Number(padding) || 0);
  const halfTooltip = Math.min(
    Math.max(0, (Number(tooltipWidth) || 0) / 2),
    Math.max(0, (safeChartWidth - safePadding * 2) / 2),
  );
  const minimum = Math.min(safeChartWidth / 2, safePadding + halfTooltip);
  const maximum = Math.max(safeChartWidth / 2, safeChartWidth - safePadding - halfTooltip);
  const value = Number.isFinite(Number(center)) ? Number(center) : safeChartWidth / 2;
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Return an accessible, dependency-free SVG line chart.
 * Series points use { value, label?, index? }. Null values create visible gaps.
 */
export function lineChartMarkup({
  series = [],
  ariaLabel = "نمودار",
  emptyLabel = "داده کافی برای رسم نمودار وجود ندارد.",
  valueLabel = defaultValueLabel,
  height = 250,
  showDots = true,
} = {}) {
  const normalized = series
    .map((item) => ({
      ...item,
      points: (Array.isArray(item.points) ? item.points : []).map((point, index) => ({ ...point, index })),
    }))
    .filter((item) => item.points.some((point) => finite(point.value) !== null));
  const allValues = normalized.flatMap((item) =>
    item.points.map((point) => finite(point.value)).filter((value) => value !== null),
  );
  const pointCount = normalized.length ? Math.max(...normalized.map((item) => item.points.length)) : 0;
  const observedPointCount = normalized.length
    ? Math.max(...normalized.map((item) => item.points.filter((point) => finite(point.value) !== null).length))
    : 0;
  if (allValues.length < 2 || pointCount < 2 || observedPointCount < 2)
    return `<div class="empty-state chart-empty">${escapeHTML(emptyLabel)}</div>`;

  const width = 760;
  const padding = { top: 18, right: 14, bottom: 34, left: 112 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = Math.max(max - min, Math.abs(max) * 0.02, 1);
  const domainMin = min - range * 0.08;
  const domainMax = max + range * 0.08;
  const hasActualDates = normalized.every((item) =>
    item.points.every((point) => finite(point.value) === null || Number.isFinite(new Date(point.date).getTime())),
  );
  const datedTimes = hasActualDates
    ? normalized.flatMap((item) =>
        item.points.filter((point) => finite(point.value) !== null).map((point) => new Date(point.date).getTime()),
      )
    : [];
  const minTime = datedTimes.length ? Math.min(...datedTimes) : 0;
  const maxTime = datedTimes.length ? Math.max(...datedTimes) : 0;
  const x = (point) => {
    const time = new Date(point.date).getTime();
    if (datedTimes.length >= 2 && Number.isFinite(time))
      return padding.left + ((time - minTime) / Math.max(maxTime - minTime, 1)) * plotWidth;
    return padding.left + (pointCount <= 1 ? 0 : point.index / (pointCount - 1)) * plotWidth;
  };
  const y = (value) => padding.top + (1 - (value - domainMin) / Math.max(domainMax - domainMin, 1)) * plotHeight;
  const grid = [0, 0.5, 1]
    .map((ratio) => {
      const lineY = padding.top + plotHeight * ratio;
      return `<line x1="${padding.left}" y1="${lineY.toFixed(2)}" x2="${width - padding.right}" y2="${lineY.toFixed(2)}" class="chart-grid-line" />`;
    })
    .join("");
  const axisValues = [domainMax, (domainMax + domainMin) / 2, domainMin];
  const yAxis = axisValues
    .map((value, index) => {
      const lineY = padding.top + plotHeight * (index / (axisValues.length - 1));
      return `<text x="${padding.left - 9}" y="${(lineY + 4).toFixed(2)}" text-anchor="end" class="chart-axis-label">${escapeHTML(valueLabel(value))}</text>`;
    })
    .join("");
  let pointSequence = 0;
  const lines = normalized
    .map((item) => {
      const segments = lineSegments(item.points);
      const paths = segments
        .map(
          (segment) =>
            `<path d="${pathFor(segment, x, y)}" class="chart-line" stroke="${escapeHTML(item.color || "#126b62")}" />`,
        )
        .join("");
      const dots = showDots
        ? item.points
            .filter((point) => finite(point.value) !== null)
            .map((point) => {
              const dateLabel = point.label || point.date || "";
              const description = [item.name || "", dateLabel, valueLabel(point.value)].filter(Boolean).join(" · ");
              const timestamp = point.date ? new Date(point.date).getTime() : point.index;
              const sequence = pointSequence++;
              return `<circle cx="${x(point).toFixed(2)}" cy="${y(point.value).toFixed(2)}" r="3.4" class="chart-dot" fill="${escapeHTML(item.color || "#126b62")}" tabindex="-1" focusable="true" aria-label="${escapeHTML(description)}" data-timestamp="${escapeHTML(timestamp)}" data-sequence="${sequence}" data-x="${x(point).toFixed(2)}" data-y="${y(point.value).toFixed(2)}"><title>${escapeHTML(description)}</title></circle>`;
            })
            .join("")
        : "";
      return paths + dots;
    })
    .join("");
  const firstSeries =
    normalized.find((item) => item.points.length === pointCount) || normalized.find((item) => item.points.length);
  const labelIndexes =
    datedTimes.length >= 2
      ? [minTime, (minTime + maxTime) / 2, maxTime].map((target) => {
          let nearestIndex = 0;
          let nearestDistance = Infinity;
          firstSeries?.points.forEach((point, index) => {
            const distance = Math.abs(new Date(point.date).getTime() - target);
            if (Number.isFinite(distance) && distance < nearestDistance) {
              nearestDistance = distance;
              nearestIndex = index;
            }
          });
          return nearestIndex;
        })
      : [0, Math.floor((pointCount - 1) / 2), pointCount - 1];
  const labels = labelIndexes
    .filter((index, position, array) => index >= 0 && array.indexOf(index) === position)
    .map((index) => {
      const point = firstSeries?.points[index];
      const xPosition = point ? x(point) : padding.left;
      const anchor =
        xPosition < padding.left + 12 ? "start" : xPosition > width - padding.right - 12 ? "end" : "middle";
      return point
        ? `<text x="${xPosition.toFixed(2)}" y="${height - 8}" text-anchor="${anchor}" class="chart-axis-label">${escapeHTML(point.label || "")}</text>`
        : "";
    })
    .join("");
  const legend =
    normalized.length > 1
      ? `<div class="chart-legend">${normalized.map((item) => `<span><i style="--legend-color:${escapeHTML(item.color || "#126b62")}"></i>${escapeHTML(item.name || "")}</span>`).join("")}</div>`
      : "";
  const crosshair = `<line class="chart-crosshair" data-axis="x" x1="0" y1="${padding.top}" x2="0" y2="${height - padding.bottom}" hidden/><line class="chart-crosshair" data-axis="y" x1="${padding.left}" y1="0" x2="${width - padding.right}" y2="0" hidden/>`;
  return `<div class="line-chart"><svg viewBox="0 0 ${width} ${height}" role="group" tabindex="0" aria-keyshortcuts="ArrowLeft ArrowRight Home End" aria-label="${escapeHTML(ariaLabel)}" preserveAspectRatio="none"><title>${escapeHTML(ariaLabel)}</title><g>${grid}${yAxis}${lines}${crosshair}${labels}</g></svg>${legend}<div class="chart-tooltip" role="status" aria-live="polite" hidden></div></div>`;
}

export function donutChartMarkup({
  segments = [],
  ariaLabel = "ترکیب دارایی‌ها",
  emptyLabel = "هنوز دارایی قابل نمایش نیست.",
  centerLabel = "کل سبد",
  centerValue = "—",
} = {}) {
  const valid = segments
    .map((segment) => ({ ...segment, value: Math.max(0, Number(segment.value) || 0) }))
    .filter((segment) => segment.value > 0);
  const total = valid.reduce((sum, segment) => sum + segment.value, 0);
  if (!total) return `<div class="empty-state chart-empty">${escapeHTML(emptyLabel)}</div>`;
  let cursor = 0;
  const stops = valid
    .map((segment) => {
      const start = (cursor / total) * 360;
      cursor += segment.value;
      const end = (cursor / total) * 360;
      return `${segment.color || "#126b62"} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
    })
    .join(", ");
  const legend = `<div class="donut-legend">${valid.map((segment) => `<div><span><i style="--legend-color:${escapeHTML(segment.color || "#126b62")}"></i><span${segment.userContent ? ' data-user-content=""' : ""}>${escapeHTML(segment.name || "")}</span></span><strong>${escapeHTML(segment.percentLabel || `${Math.round((segment.value / total) * 100)}%`)}</strong></div>`).join("")}</div>`;
  return `<div class="donut-layout"><div class="donut-chart" role="img" aria-label="${escapeHTML(ariaLabel)}" style="--donut-stops:${escapeHTML(stops)}"><div><small>${escapeHTML(centerLabel)}</small><strong>${escapeHTML(centerValue)}</strong></div></div>${legend}</div>`;
}

export function barChartMarkup({
  items = [],
  ariaLabel = "Bar chart",
  emptyLabel = "Not enough data to draw this chart.",
  valueLabel = defaultValueLabel,
  height = 250,
} = {}) {
  const values = (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      label: String(item?.label || ""),
      value: finite(item?.value),
      color: item?.color || "var(--chart-portfolio)",
      index,
    }))
    .filter((item) => item.value !== null && item.value >= 0);
  if (!values.length) return `<div class="empty-state chart-empty">${escapeHTML(emptyLabel)}</div>`;

  const width = 760;
  const padding = { top: 16, right: 18, bottom: 42, left: 78 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const max = Math.max(...values.map((item) => item.value), 1);
  const slotWidth = plotWidth / values.length;
  const barWidth = Math.min(44, slotWidth * 0.58);
  const grid = [0, 0.5, 1]
    .map((ratio) => {
      const lineY = padding.top + plotHeight * (1 - ratio);
      return `<line x1="${padding.left}" y1="${lineY.toFixed(2)}" x2="${width - padding.right}" y2="${lineY.toFixed(2)}" class="chart-grid-line" /><text x="${padding.left - 8}" y="${(lineY + 4).toFixed(2)}" text-anchor="end" class="chart-axis-label">${escapeHTML(valueLabel(max * ratio))}</text>`;
    })
    .join("");
  const baseline = padding.top + plotHeight;
  const bars = values
    .map((item) => {
      const barHeight = (item.value / max) * plotHeight;
      const x = padding.left + item.index * slotWidth + (slotWidth - barWidth) / 2;
      const y = baseline - barHeight;
      const description = `${item.label} · ${valueLabel(item.value)}`;
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(barHeight, 1).toFixed(2)}" rx="5" fill="${escapeHTML(item.color)}" class="chart-bar" tabindex="0" focusable="true" role="img" aria-label="${escapeHTML(description)}" data-sequence="${item.index}"><title>${escapeHTML(description)}</title></rect><text x="${(x + barWidth / 2).toFixed(2)}" y="${height - 12}" text-anchor="middle" class="chart-axis-label">${escapeHTML(item.label)}</text>`;
    })
    .join("");
  return `<div class="line-chart bar-chart-visualization"><svg viewBox="0 0 ${width} ${height}" role="group" tabindex="0" aria-label="${escapeHTML(ariaLabel)}" preserveAspectRatio="none"><title>${escapeHTML(ariaLabel)}</title>${grid}<line x1="${padding.left}" y1="${baseline}" x2="${width - padding.right}" y2="${baseline}" class="chart-baseline" />${bars}</svg><div class="chart-tooltip" role="status" aria-live="polite" hidden></div></div>`;
}

export function allocationBarChartMarkup({
  items = [],
  ariaLabel = "Actual versus target allocation",
  emptyLabel = "No allocation data to display.",
  actualLabel = "Actual",
  targetLabel = "Target",
  valueLabel = defaultValueLabel,
} = {}) {
  const values = (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      label: String(item?.label || ""),
      actual: finite(item?.actual),
      target: finite(item?.target),
      color: item?.color || "var(--chart-portfolio)",
      index,
    }))
    .filter((item) => item.actual !== null || item.target !== null);
  if (!values.length) return `<div class="empty-state chart-empty">${escapeHTML(emptyLabel)}</div>`;

  const width = 760;
  const rowHeight = 52;
  const padding = { top: 38, right: 20, bottom: 20, left: 160 };
  const height = padding.top + padding.bottom + values.length * rowHeight;
  const plotWidth = width - padding.left - padding.right;
  const max = 100;
  const scale = (value) => (Math.max(0, Math.min(max, value)) / max) * plotWidth;
  const grid = [0, 50, 100]
    .map((value) => {
      const x = padding.left + scale(value);
      return `<line x1="${x.toFixed(2)}" y1="${padding.top - 18}" x2="${x.toFixed(2)}" y2="${height - padding.bottom}" class="chart-grid-line" /><text x="${x.toFixed(2)}" y="14" text-anchor="middle" class="chart-axis-label">${escapeHTML(valueLabel(value))}</text>`;
    })
    .join("");
  let pointSequence = 0;
  const rows = values
    .map((item, index) => {
      const y = padding.top + index * rowHeight;
      const actualY = y + 2;
      const targetY = y + 26;
      const actualWidth = item.actual === null ? 0 : scale(item.actual);
      const targetWidth = item.target === null ? 0 : scale(item.target);
      const actualSequence = pointSequence++;
      const targetSequence = pointSequence++;
      const actualDescription = `${item.label} · ${actualLabel} · ${item.actual === null ? emptyLabel : valueLabel(item.actual)}`;
      const targetDescription = `${item.label} · ${targetLabel} · ${item.target === null ? emptyLabel : valueLabel(item.target)}`;
      return `<text x="${padding.left - 12}" y="${(y + 20).toFixed(2)}" text-anchor="end" class="chart-axis-label">${escapeHTML(item.label)}</text>${item.actual === null ? "" : `<rect x="${padding.left}" y="${actualY}" width="${actualWidth.toFixed(2)}" height="14" rx="4" fill="${escapeHTML(item.color)}" class="chart-bar" tabindex="0" focusable="true" role="img" aria-label="${escapeHTML(actualDescription)}" data-sequence="${actualSequence}"><title>${escapeHTML(actualDescription)}</title></rect>`}${item.target === null ? "" : `<rect x="${padding.left}" y="${targetY}" width="${targetWidth.toFixed(2)}" height="14" rx="4" fill="var(--chart-target)" class="chart-bar chart-bar-target" tabindex="0" focusable="true" role="img" aria-label="${escapeHTML(targetDescription)}" data-sequence="${targetSequence}"><title>${escapeHTML(targetDescription)}</title></rect>`}`;
    })
    .join("");
  const legend = `<div class="chart-legend"><span><i style="--legend-color:var(--chart-portfolio)"></i>${escapeHTML(actualLabel)}</span><span><i style="--legend-color:var(--chart-target)"></i>${escapeHTML(targetLabel)}</span></div>`;
  return `<div class="line-chart bar-chart-visualization"><svg viewBox="0 0 ${width} ${height}" role="group" tabindex="0" aria-label="${escapeHTML(ariaLabel)}" preserveAspectRatio="none"><title>${escapeHTML(ariaLabel)}</title>${grid}${rows}</svg>${legend}<div class="chart-tooltip" role="status" aria-live="polite" hidden></div></div>`;
}

export function normalizeSeriesIndex(points, fallbackLabel = "") {
  const values = (Array.isArray(points) ? points : []).map((point, index) => ({
    value: finite(point && (point.value ?? point.nominal)),
    label: point?.label || point?.date || fallbackLabel || String(index + 1),
  }));
  const base = values.find((point) => point.value !== null)?.value;
  return base && base !== 0
    ? values.map((point) => ({ ...point, value: point.value === null ? null : (point.value / base) * 100 }))
    : values.map((point) => ({ ...point, value: null }));
}
