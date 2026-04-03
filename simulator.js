let points = [];
let drawnPaths = [];
let armL1 = 150;
let armL2 = 150;
let currentIdx = 0;
let playing = false;
let simSpeed = 1;
let scaleFactor = 2;
let brushSize = 2;

let effX = 0;
let effY = 0;
let isPenDown = false;
let lastPenDown = false;

function setup() {
  const container = document.getElementById("sim-canvas-container");
  const w = container ? Math.max(700, container.clientWidth - 20) : 800;
  const h = container ? Math.max(420, container.clientHeight - 20) : 600;

  const canvas = createCanvas(w, h);
  canvas.parent("sim-canvas-container");

  document.getElementById("gcodeInput").addEventListener("change", handleGcode);
  document.getElementById("speedSlider").addEventListener("input", e => {
    simSpeed = parseInt(e.target.value, 10);
    document.getElementById("speedVal").innerText = simSpeed;
  });

  document.getElementById("brushSlider").addEventListener("input", e => {
    brushSize = parseInt(e.target.value, 10);
    document.getElementById("brushVal").innerText = brushSize;
  });

  document.getElementById("btnPlay").addEventListener("click", () => {
    playing = true;
  });

  document.getElementById("btnPause").addEventListener("click", () => {
    playing = false;
  });

  document.getElementById("btnReset").addEventListener("click", resetSimulationState);
}

function windowResized() {
  const container = document.getElementById("sim-canvas-container");
  if (!container) return;
  resizeCanvas(Math.max(700, container.clientWidth - 20), Math.max(420, container.clientHeight - 20));
}

function resetSimulationState() {
  currentIdx = 0;
  playing = false;
  drawnPaths = [];
  lastPenDown = false;
  effX = 0;
  effY = 0;
}

function handleGcode(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = event => {
    parseSimGcode(String(event.target.result || ""));
  };
  reader.readAsText(file);
}

function parseSimGcode(gcodeText) {
  points = [];
  resetSimulationState();
  isPenDown = false;

  const lines = gcodeText.split("\n");
  let lastX = 0;
  let lastY = 0;

  for (let line of lines) {
    line = line.trim().toUpperCase();
    if (!line || line.startsWith(";")) continue;

    const penDownState = line.includes("M03 S20") ? true : (line.includes("M03 S0") ? false : null);
    if (penDownState !== null) isPenDown = penDownState;

    if (!line.startsWith("G0") && !line.startsWith("G1")) continue;

    const mx = line.match(/X([\d.-]+)/);
    const my = line.match(/Y([\d.-]+)/);
    const cx = mx ? parseFloat(mx[1]) : lastX;
    const cy = my ? parseFloat(my[1]) : lastY;

    if (line.startsWith("G1")) {
      const d = distance(lastX, lastY, cx, cy);
      const steps = Math.max(1, Math.ceil(d / 2));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        points.push({
          x: lastX + (cx - lastX) * t,
          y: lastY + (cy - lastY) * t,
          p: isPenDown
        });
      }
    } else {
      points.push({ x: cx, y: cy, p: false });
    }

    lastX = cx;
    lastY = cy;
  }
}

function draw() {
  background(30);

  push();
  translate(width * 0.25, height * 0.75);

  stroke(50);
  strokeWeight(1);
  for (let i = -width; i <= width; i += 50) line(i, -height, i, height);
  for (let j = -height; j <= height; j += 50) line(-width, j, width, j);

  scale(scaleFactor);

  stroke(80);
  strokeWeight(1 / scaleFactor);
  fill(40);
  rect(0, -210, 297, 210);

  if (playing && points.length > 0 && currentIdx < points.length) {
    for (let s = 0; s < simSpeed; s++) {
      if (currentIdx >= points.length) break;
      const pt = points[currentIdx];
      effX = pt.x;
      effY = pt.y;

      if (pt.p) {
        if (!lastPenDown || drawnPaths.length === 0) {
          drawnPaths.push([]);
        }
        drawnPaths[drawnPaths.length - 1].push({ x: pt.x, y: pt.y });
      }

      lastPenDown = pt.p;
      currentIdx++;
    }
  }

  stroke(255, 100, 100);
  strokeWeight(brushSize / scaleFactor);
  noFill();
  for (const path of drawnPaths) {
    beginShape();
    for (const pt of path) vertex(pt.x, -pt.y);
    endShape();
  }

  const d2 = effX * effX + effY * effY;
  let D = (d2 - armL1 * armL1 - armL2 * armL2) / (2 * armL1 * armL2);
  D = constrain(D, -1, 1);

  const theta2 = Math.acos(D);
  const theta1 = Math.atan2(effY, effX) - Math.atan2(armL2 * Math.sin(theta2), armL1 + armL2 * Math.cos(theta2));

  const elbowX = armL1 * Math.cos(theta1);
  const elbowY = armL1 * Math.sin(theta1);
  const pX = elbowX + armL2 * Math.cos(theta1 + theta2);
  const pY = elbowY + armL2 * Math.sin(theta1 + theta2);

  fill(200);
  stroke(255);
  circle(0, 0, 10);

  stroke(0, 200, 255);
  strokeWeight(4);
  line(0, 0, elbowX, -elbowY);

  stroke(0, 255, 100);
  line(elbowX, -elbowY, pX, -pY);

  fill(255);
  noStroke();
  circle(pX, -pY, Math.max(4, brushSize * 0.8));

  pop();

  fill(255);
  text("Progression: " + (points.length ? Math.floor((currentIdx / points.length) * 100) : 0) + "%", 20, 30);
}

function distance(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}