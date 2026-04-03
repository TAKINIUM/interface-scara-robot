const PAPER_W = 297;
const PAPER_H = 210;
const PEN_UP = "M03 S0\n";
const PEN_DOWN = "M03 S20\n";
const FEED_MOVE = "5000";
const FEED_RAPID = "10000";

let pointPaths = [];
let viewScale = 2;
let viewOffset = { x: 50, y: 50 };
let showTravelMoves = false;
let currentProcessedSVG = "";
let tempImg = null;
let loadedExternalGcode = null;
let previewUpdateTimer = null;

const TRACE_SETTINGS = {
  threshold: 0.5,
  invert: false,
  edge: false,
  contrast: 0,
  smooth: 0,
  detail: 3
};

function setup() {
  const container = document.getElementById("canvas-container");
  const w = container ? container.offsetWidth : windowWidth * 0.8;
  const h = container ? container.offsetHeight : windowHeight * 0.7;

  const canvas = createCanvas(w, h);
  canvas.parent("canvas-container");
  pixelDensity(1);
  noLoop();

  bindUiEvents();
  resetView();
  requestRender();
}

function bindUiEvents() {
  document.getElementById("fileInput").addEventListener("change", handleFile);
  document.getElementById("btnGcode").addEventListener("click", exportGcode);
  document.getElementById("btnReset").addEventListener("click", () => {
    resetView();
    requestRender();
  });
  document.getElementById("btnToggleTravel").addEventListener("click", toggleTravelMoves);
  document.getElementById("btnCancelModal").addEventListener("click", closeModal);
  document.getElementById("btnConfirmModal").addEventListener("click", confirmImage);

  ["modalThreshold", "modalInvert", "modalEdge", "modalContrast", "modalSmooth", "modalDetail"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const eventName = el.type === "checkbox" ? "change" : "input";
    el.addEventListener(eventName, schedulePreviewUpdate);
  });
}

function windowResized() {
  const container = document.getElementById("canvas-container");
  if (!container) return;
  resizeCanvas(container.offsetWidth, container.offsetHeight);
  resetView();
  requestRender();
}

function requestRender() {
  redraw();
}

function handleFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  pointPaths = [];
  loadedExternalGcode = null;

  const filename = file.name.toLowerCase();
  if (filename.endsWith(".gcode") || filename.endsWith(".nc") || filename.endsWith(".txt")) {
    const reader = new FileReader();
    reader.onload = e => {
      loadedExternalGcode = String(e.target.result || "");
      parseGcodeForPreview(loadedExternalGcode);
      autoFit();
      requestRender();
    };
    reader.readAsText(file);
    return;
  }

  if (file.type.startsWith("image/")) {
    openImageModal(URL.createObjectURL(file));
    return;
  }

  const reader = new FileReader();
  reader.onload = e => {
    parseSVG(String(e.target.result || ""));
    autoFit();
    requestRender();
  };
  reader.readAsText(file);
}

function openImageModal(url) {
  const modal = document.getElementById("imageModal");
  modal.style.display = "flex";

  tempImg = new Image();
  tempImg.onload = () => {
    schedulePreviewUpdate(true);
  };
  tempImg.src = url;
}

function closeModal() {
  document.getElementById("imageModal").style.display = "none";
  document.getElementById("fileInput").value = "";
  tempImg = null;
  currentProcessedSVG = "";
  if (previewUpdateTimer) {
    clearTimeout(previewUpdateTimer);
    previewUpdateTimer = null;
  }
}

function schedulePreviewUpdate(immediate = false) {
  if (previewUpdateTimer) clearTimeout(previewUpdateTimer);
  if (immediate) {
    updateImagePreview();
    return;
  }
  previewUpdateTimer = setTimeout(updateImagePreview, 70);
}

function readTraceSettings() {
  TRACE_SETTINGS.threshold = clampNumber(parseFloat(document.getElementById("modalThreshold").value), 0, 1, 0.5);
  TRACE_SETTINGS.invert = !!document.getElementById("modalInvert").checked;
  TRACE_SETTINGS.edge = !!document.getElementById("modalEdge").checked;
  TRACE_SETTINGS.contrast = clampNumber(parseFloat(document.getElementById("modalContrast").value), -1, 1, 0);
  TRACE_SETTINGS.smooth = clampNumber(parseInt(document.getElementById("modalSmooth").value, 10), 0, 4, 0);
  TRACE_SETTINGS.detail = clampNumber(parseInt(document.getElementById("modalDetail").value, 10), 1, 5, 3);
}

function updateImagePreview() {
  if (!tempImg) return;

  readTraceSettings();

  const maxDim = 760;
  const ratio = Math.min(1, maxDim / Math.max(tempImg.width, tempImg.height));
  const targetWidth = Math.max(1, Math.floor(tempImg.width * ratio));
  const targetHeight = Math.max(1, Math.floor(tempImg.height * ratio));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tempImg, 0, 0, targetWidth, targetHeight);

  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const gray = buildGrayBuffer(imageData.data, TRACE_SETTINGS.contrast);
  const smoothGray = TRACE_SETTINGS.smooth > 0
    ? blurGray(gray, targetWidth, targetHeight, TRACE_SETTINGS.smooth)
    : gray;

  let finalGray = smoothGray;
  if (TRACE_SETTINGS.edge) {
    finalGray = applySobel(smoothGray, targetWidth, targetHeight);
  }

  applyBinaryAlpha(imageData.data, finalGray, TRACE_SETTINGS.threshold, TRACE_SETTINGS.invert);

  const d = TRACE_SETTINGS.detail;
  const options = {
    ltres: map(d, 1, 5, 1.3, 0.4),
    qtres: map(d, 1, 5, 1.2, 0.35),
    pathomit: Math.round(map(d, 1, 5, 12, 1)),
    rightangleenhance: true,
    colorsampling: 0,
    numberofcolors: 2,
    mincolorratio: 0,
    blurradius: 0,
    blurdelta: 16
  };

  currentProcessedSVG = ImageTracer.imagedataToSVG(imageData, options);
  const preview = document.getElementById("previewContainer");
  preview.innerHTML = currentProcessedSVG;
  const svgEl = preview.querySelector("svg");
  if (svgEl) {
    svgEl.style.width = "100%";
    svgEl.style.height = "100%";
  }
}

function buildGrayBuffer(rgba, contrast) {
  const out = new Uint8Array(rgba.length / 4);
  const c = Math.max(-1, Math.min(1, contrast));
  const factor = (259 * (c * 255 + 255)) / (255 * (259 - c * 255));

  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const gray = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    const adjusted = factor * (gray - 128) + 128;
    out[p] = clampByte(adjusted);
  }
  return out;
}

function blurGray(gray, w, h, radius) {
  let src = gray;
  let dst = new Uint8Array(gray.length);

  for (let pass = 0; pass < radius; pass++) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(w - 1, x + 1);
        let sum = 0;
        let count = 0;
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            sum += src[yy * w + xx];
            count++;
          }
        }
        dst[y * w + x] = Math.round(sum / count);
      }
    }
    const temp = src;
    src = dst;
    dst = temp;
  }
  return src;
}

function applySobel(gray, w, h) {
  const out = new Uint8Array(gray.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p00 = gray[(y - 1) * w + (x - 1)];
      const p01 = gray[(y - 1) * w + x];
      const p02 = gray[(y - 1) * w + (x + 1)];
      const p10 = gray[y * w + (x - 1)];
      const p12 = gray[y * w + (x + 1)];
      const p20 = gray[(y + 1) * w + (x - 1)];
      const p21 = gray[(y + 1) * w + x];
      const p22 = gray[(y + 1) * w + (x + 1)];

      const gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;
      const gy = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;
      const mag = Math.min(255, Math.sqrt(gx * gx + gy * gy));
      
      out[y * w + x] = 255 - mag;
    }
  }
  for (let i = 0; i < w; i++) { out[i] = 255; out[(h - 1) * w + i] = 255; }
  for (let i = 0; i < h; i++) { out[i * w] = 255; out[i * w + w - 1] = 255; }
  
  return out;
}

function applyBinaryAlpha(rgba, gray, threshold, invert) {
  const gate = threshold * 255;
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const dark = gray[p] < gate;
    const keep = invert ? !dark : dark;
    if (keep) {
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    } else {
      rgba[i + 3] = 0;
    }
  }
}

function confirmImage() {
  if (!currentProcessedSVG) return;
  parseSVG(currentProcessedSVG);
  autoFit();
  requestRender();
  closeModal();
}

function parseGcodeForPreview(gcodeStr) {
  const lines = gcodeStr.split("\n");
  const raw = [];
  let currentPath = [];
  let lastX = 0;
  let lastY = 0;
  let penDown = false;

  lines.forEach(line => {
    const clean = line.trim().toUpperCase();
    if (!clean || clean.startsWith(";")) return;

    if (clean.includes("M03 S20")) penDown = true;
    if (clean.includes("M03 S0")) penDown = false;

    if (!clean.startsWith("G0") && !clean.startsWith("G1")) return;

    const xMatch = /X([\d.-]+)/.exec(clean);
    const yMatch = /Y([\d.-]+)/.exec(clean);
    const x = xMatch ? parseFloat(xMatch[1]) : lastX;
    const yGcode = yMatch ? parseFloat(yMatch[1]) : lastY;
    const yCanvas = PAPER_H - yGcode;

    if (clean.startsWith("G0") || !penDown) {
      if (currentPath.length > 1) raw.push(currentPath);
      currentPath = [];
    } else {
      if (currentPath.length === 0) {
        currentPath.push({ x: lastX, y: PAPER_H - lastY });
      }
      currentPath.push({ x, y: yCanvas });
    }

    lastX = x;
    lastY = yGcode;
  });

  if (currentPath.length > 1) raw.push(currentPath);
  pointPaths = normalizeDrawingPaths(raw, false);
}

function parseSVG(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "image/svg+xml");
  const svgPaths = Array.from(doc.querySelectorAll("path"));
  const raw = [];

  for (const origPath of svgPaths) {
    const dAttr = origPath.getAttribute("d");
    if (!dAttr) continue;

    const subD = dAttr.split(/(?=[Mm])/).filter(s => s.trim().length > 0);

    for (const sd of subD) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", sd);

      const len = path.getTotalLength();
      if (!Number.isFinite(len) || len < 1.5) continue;

      const step = Math.max(0.6, len / 1200);
      const splitGap = Math.max(3.5, step * 4);
      let points = [];
      let lastPoint = null;

      for (let d = 0; d <= len; d += step) {
        const p = path.getPointAtLength(d);
        const point = { x: p.x, y: p.y };

        if (lastPoint && Math.sqrt(distSq(lastPoint.x, lastPoint.y, point.x, point.y)) > splitGap) {
          if (points.length > 1) raw.push(points);
          points = [];
        }

        points.push(point);
        lastPoint = point;
      }

      if (points.length > 1) raw.push(points);
    }
  }

  pointPaths = normalizeDrawingPaths(raw, true);
}

function normalizeDrawingPaths(rawPaths, reorder) {
  let paths = rawPaths
    .flatMap(path => splitPathOnJumps(cleanupPath(path, 0.15, 0.3)))
    .filter(path => path.length > 1 && pathLength(path) >= 2.0);

  paths = removeDuplicatePaths(paths, 0.4, 0.7);

  if (reorder) {
    paths = reorderByNearest(paths);
  }

  return paths;
}

function splitPathOnJumps(path) {
  if (!path || path.length < 3) return path && path.length > 1 ? [path] : [];

  const lengths = [];
  for (let i = 1; i < path.length; i++) {
    lengths.push(Math.sqrt(distSq(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y)));
  }

  const sorted = lengths.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const jumpLimit = Math.max(3.5, median * 5);
  const pieces = [];
  let current = [path[0]];

  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const cur = path[i];
    const dist = Math.sqrt(distSq(prev.x, prev.y, cur.x, cur.y));

    if (dist > jumpLimit) {
      if (current.length > 1) pieces.push(current);
      current = [cur];
      continue;
    }

    current.push(cur);
  }

  if (current.length > 1) pieces.push(current);
  return pieces;
}

function cleanupPath(path, minPointGap, simplifyTolerance) {
  if (!path || path.length < 2) return [];

  const compact = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const prev = compact[compact.length - 1];
    const cur = path[i];
    if (distSq(prev.x, prev.y, cur.x, cur.y) >= minPointGap * minPointGap) {
      compact.push(cur);
    }
  }

  if (compact.length < 2) return [];

  const first = compact[0];
  const last = compact[compact.length - 1];
  if (distSq(first.x, first.y, last.x, last.y) < minPointGap * minPointGap) {
    compact.pop();
  }

  if (compact.length < 3) return compact;
  return simplifyRDP(compact, simplifyTolerance);
}

function simplifyRDP(points, epsilon) {
  if (points.length < 3) return points;

  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = -1;
  let idx = -1;

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointLineDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }

  if (maxDist <= epsilon || idx === -1) {
    return [first, last];
  }

  const left = simplifyRDP(points.slice(0, idx + 1), epsilon);
  const right = simplifyRDP(points.slice(idx), epsilon);
  return left.slice(0, -1).concat(right);
}

function pointLineDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.sqrt(distSq(p.x, p.y, a.x, a.y));

  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  const k = Math.max(0, Math.min(1, t));
  const px = a.x + k * dx;
  const py = a.y + k * dy;
  return Math.sqrt(distSq(p.x, p.y, px, py));
}

function removeDuplicatePaths(paths, grid, duplicateRatio) {
  const kept = [];
  const seenSegments = new Set();

  for (const path of paths) {
    let total = 0;
    let duplicate = 0;

    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const key = segmentKey(a, b, grid);
      total++;
      if (seenSegments.has(key)) duplicate++;
    }

    const ratio = total > 0 ? duplicate / total : 1;
    if (ratio >= duplicateRatio) continue;

    kept.push(path);
    for (let i = 1; i < path.length; i++) {
      seenSegments.add(segmentKey(path[i - 1], path[i], grid));
    }
  }

  return kept;
}

function segmentKey(a, b, grid) {
  const ax = Math.round(a.x / grid);
  const ay = Math.round(a.y / grid);
  const bx = Math.round(b.x / grid);
  const by = Math.round(b.y / grid);
  if (ax < bx || (ax === bx && ay <= by)) {
    return `${ax},${ay}|${bx},${by}`;
  }
  return `${bx},${by}|${ax},${ay}`;
}

function reorderByNearest(paths) {
  if (paths.length < 2) return paths;

  const remaining = paths.map(path => ({ path }));
  const ordered = [];
  let cursor = { x: 0, y: 0 };

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestReverse = false;
    let bestDist = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const path = remaining[i].path;
      const start = path[0];
      const end = path[path.length - 1];
      const dStart = distSq(cursor.x, cursor.y, start.x, start.y);
      const dEnd = distSq(cursor.x, cursor.y, end.x, end.y);

      if (dStart < bestDist) {
        bestDist = dStart;
        bestIdx = i;
        bestReverse = false;
      }
      if (dEnd < bestDist) {
        bestDist = dEnd;
        bestIdx = i;
        bestReverse = true;
      }
    }

    const next = remaining.splice(bestIdx, 1)[0].path;
    const chosen = bestReverse ? next.slice().reverse() : next;
    ordered.push(chosen);
    cursor = chosen[chosen.length - 1];
  }

  return ordered;
}

function pathLength(path) {
  let sum = 0;
  for (let i = 1; i < path.length; i++) {
    sum += Math.sqrt(distSq(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y));
  }
  return sum;
}

function autoFit() {
  if (pointPaths.length === 0) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  pointPaths.forEach(path => {
    path.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    });
  });

  const dW = Math.max(1, maxX - minX);
  const dH = Math.max(1, maxY - minY);
  const margin = 0.9;
  const finalScale = Math.min((PAPER_W * margin) / dW, (PAPER_H * margin) / dH);
  const contentW = dW * finalScale;
  const contentH = dH * finalScale;
  const offsetX = (PAPER_W - contentW) / 2;
  const offsetY = (PAPER_H - contentH) / 2;

  pointPaths = pointPaths.map(path =>
    path.map(p => ({
      x: (p.x - minX) * finalScale + offsetX,
      y: (p.y - minY) * finalScale + offsetY
    }))
  );
}

function draw() {
  background(44, 62, 80);

  push();
  translate(viewOffset.x, viewOffset.y);
  scale(viewScale);

  fill(255);
  noStroke();
  rect(0, 0, PAPER_W, PAPER_H);

  strokeWeight(0.5 / viewScale);
  noFill();

  let lastX = 0;
  let lastY = 0;

  for (const path of pointPaths) {
    if (path.length === 0) continue;

    if (showTravelMoves) {
      stroke(231, 76, 60, 100);
      line(lastX, lastY, path[0].x, path[0].y);
    }

    stroke(41, 128, 185);
    beginShape();
    for (const p of path) {
      vertex(p.x, p.y);
    }
    endShape();

    lastX = path[path.length - 1].x;
    lastY = path[path.length - 1].y;
  }

  if (showTravelMoves && pointPaths.length > 0) {
    stroke(231, 76, 60, 100);
    line(lastX, lastY, 0, 0);
  }

  pop();
}

function mouseWheel(event) {
  viewScale -= event.delta * 0.001;
  viewScale = constrain(viewScale, 0.1, 10);
  requestRender();
  return false;
}

function mouseDragged() {
  if (mouseX > 0 && mouseX < width && mouseY > 0 && mouseY < height) {
    viewOffset.x += movedX;
    viewOffset.y += movedY;
    requestRender();
  }
}

function resetView() {
  viewScale = Math.min(width / (PAPER_W * 1.1), height / (PAPER_H * 1.1));
  viewOffset.x = (width - PAPER_W * viewScale) / 2;
  viewOffset.y = (height - PAPER_H * viewScale) / 2;
}

function toggleTravelMoves() {
  showTravelMoves = !showTravelMoves;
  const btn = document.getElementById("btnToggleTravel");
  btn.innerText = "TRAVEL: " + (showTravelMoves ? "ON" : "OFF");
  btn.style.background = showTravelMoves ? "#e67e22" : "#3498db";
  requestRender();
}

function getCurrentGcode() {
  if (loadedExternalGcode) {
    return loadedExternalGcode;
  }

  if (pointPaths.length === 0) return null;

  const optimized = reorderByNearest(pointPaths.map(path => path.slice()));
  let gcode = "G90\n" + PEN_UP + `G0 F${FEED_RAPID} X0 Y0\n`;
  let lastOutX = null;
  let lastOutY = null;

  optimized.forEach(path => {
    if (path.length < 2) return;

    const startX = path[0].x;
    const startY = PAPER_H - path[0].y;
    gcode += `G0 X${startX.toFixed(3)} Y${startY.toFixed(3)}\n`;
    gcode += PEN_DOWN;

    lastOutX = startX;
    lastOutY = startY;

    for (let i = 1; i < path.length; i++) {
      const x = path[i].x;
      const y = PAPER_H - path[i].y;
      if (lastOutX !== null && distSq(x, y, lastOutX, lastOutY) < 0.01) {
        continue;
      }
      gcode += `G1 X${x.toFixed(3)} Y${y.toFixed(3)} F${FEED_MOVE}\n`;
      lastOutX = x;
      lastOutY = y;
    }

    gcode += PEN_UP;
  });

  gcode += "G0 X0 Y0\n";
  return gcode;
}

function exportGcode() {
  const gcode = getCurrentGcode();
  if (!gcode) {
    alert("Aucun dessin !");
    return;
  }

  const blob = new Blob([gcode], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "Image.gcode";
  a.click();
  URL.revokeObjectURL(url);
}

function distSq(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

function clampByte(v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v | 0;
}

function clampNumber(v, min, max, fallback) {
  if (!Number.isFinite(v)) return fallback;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}